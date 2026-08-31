/**
 * Distills AMENITY_SOURCES (constants.js) into the three committed amenity
 * dataset files the backend serves from at runtime.
 *
 *   npm run build:amenities
 *   npm run build:amenities -- --dry-run
 *
 * WHY THIS EXISTS: the amenity scores (transit/parks/bike) are static-data
 * scores — no live upstream call sits on the request path. This script is
 * the ONE place that talks to the raw sources (2 different Socrata catalogs,
 * 5 separate MTA bus GTFS zips, and Citi Bike's live GBFS feed); everything
 * downstream reads only the committed JSON it produces (or the Mongo copy of
 * it — see providers/amenities/index.js).
 *
 * Run `npm run verify:amenities` FIRST if this is the first run, or if a
 * rerun ever looks suspiciously thin — that script confirms each source
 * still resolves and reports actual row counts before this one commits to
 * writing anything.
 *
 * OUTPUT — three files in src/config/amenities/, kept separate so a bike-only
 * refresh (the monthly cron; see CLAUDE.md) produces a readable git diff and
 * no single document risks Mongo's 16MB BSON limit:
 *
 *   transit.json   { subway, bus, rail }
 *   parks.json     { park, playground, garden }
 *   bike.json      { bikeShare, bikeLane, protectedLane }
 *
 * Each bucket is encoded as flat numeric triples, not an array of objects —
 * for the ~48k densified bike-lane points this is the difference between
 * roughly 4MB and 1.2MB:
 *
 *   { pts: [lat, lng, nameIdx, lat, lng, nameIdx, ...], names: [...], n }
 *
 * nameIdx -1 means unnamed (not every source has a usable per-point name).
 *
 * ROUTES (transit.subway and transit.bus ONLY — see CLAUDE.md's routes
 * contract-change note): an ADDITIVE pair of fields alongside `pts`/`names`,
 * interned the same way names are —
 *
 *   { pts: [...], names: [...], n, routeSets: [["4","5","6"], ...], routeIdx: [0, -1, ...] }
 *
 * `routeIdx` is parallel to points BY POINT INDEX (one entry per point, i.e.
 * index i, not i*3) and points into `routeSets`; -1 means no route data for
 * that point. Every other bucket (rail, park, playground, garden, bikeShare,
 * bikeLane, protectedLane) has neither field, unchanged from before this
 * existed — see providers/amenities/bikeShare.js's encodeBucket.
 *
 * SANITY GUARD: refuses to write if any bucket's point count falls more than
 * 30% below the currently-committed file's — the entire defense against a
 * truncated download (a redirect gone stale, a GTFS feed 404ing silently)
 * degrading every amenity score in the city. Same threshold and same
 * reasoning as buildBaseline.js's usable-sample guard.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AMENITY_SOURCES,
  AMENITY_LANE_SPACING_METERS,
  PARKS_TYPECATEGORY_TO_BUCKET,
  SOCRATA_ROW_LIMIT,
  SUBWAY_ROUTE_MATCH_RADIUS_METERS,
  NYC_BOUNDS,
} from "../src/config/constants.js";
import { densifyLine, haversineMeters, multiPolygonCentroid } from "../src/lib/geo.js";
import { encodeBucket, fetchBikeShareBucket } from "../src/providers/amenities/bikeShare.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "src", "config", "amenities");

// --- args ----------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const DRY_RUN = args["dry-run"] === "true";

// A bucket below this share of its previously-committed point count is
// treated as a truncated fetch, not a genuine dataset shrink.
const SANITY_GUARD_MIN_SHARE = 0.7;

function inBounds(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= NYC_BOUNDS.minLat - 0.5 && // generous margin — see rail note below
    lat <= NYC_BOUNDS.maxLat + 0.5 &&
    lng >= NYC_BOUNDS.minLng - 0.5 &&
    lng <= NYC_BOUNDS.maxLng + 0.5
  );
}

// --- generic Socrata fetch (paginated, unlike verifyAmenities.js's sample) --

async function fetchAllSocrataRows(domain, datasetId, params = {}) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(
      `https://${domain}/resource/${datasetId}.json?${new URLSearchParams({
        ...params,
        $limit: String(SOCRATA_ROW_LIMIT),
        $offset: String(offset),
      })}`
    );
    if (!res.ok) {
      throw new Error(`${domain}/${datasetId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < SOCRATA_ROW_LIMIT) break;
    offset += SOCRATA_ROW_LIMIT;
  }
  return rows;
}

// --- subway / rail (Socrata point sources) ----------------------------------

async function buildPointBucket(source) {
  const rows = await fetchAllSocrataRows(source.domain, source.datasetId);
  const points = [];
  for (const row of rows) {
    const lat = Number(row[source.latField]);
    const lng = Number(row[source.lngField]);
    if (!inBounds(lat, lng)) continue;
    points.push({ lat, lng, name: row[source.nameField] || null });
  }
  return encodeBucket(points);
}

// --- subway route join (i9wp-a4ja entrances x 39hk-dx4f station routes) -----
//
// The entrances dataset has no route info; the separate "MTA Subway
// Stations" dataset does (`daytime_routes`), but at the STATION's own
// coordinate, not the entrance's — the two never share an exact point or a
// key, so this is a nearest-within-radius join, not a lookup. Brute-force
// (every entrance x every station) is fine here: ~2,120 entrances against a
// few hundred stations is on the order of 10^6 comparisons, trivial for a
// one-off build script.

async function buildSubwayBucketWithRoutes(entranceSource, stationSource) {
  const [entranceRows, stationRows] = await Promise.all([
    fetchAllSocrataRows(entranceSource.domain, entranceSource.datasetId),
    fetchAllSocrataRows(stationSource.domain, stationSource.datasetId),
  ]);

  const stations = [];
  for (const row of stationRows) {
    const lat = Number(row[stationSource.latField]);
    const lng = Number(row[stationSource.lngField]);
    if (!inBounds(lat, lng)) continue;
    const routes = String(row[stationSource.routesField] || "")
      .split(/\s+/)
      .map((r) => r.trim())
      .filter(Boolean);
    if (routes.length === 0) continue; // nothing usable to join
    stations.push({ lat, lng, routes });
  }

  const points = [];
  let matched = 0;
  for (const row of entranceRows) {
    const lat = Number(row[entranceSource.latField]);
    const lng = Number(row[entranceSource.lngField]);
    if (!inBounds(lat, lng)) continue;

    let best = null;
    let bestMeters = Infinity;
    for (const station of stations) {
      const meters = haversineMeters(lat, lng, station.lat, station.lng);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = station;
      }
    }

    const routes =
      best && bestMeters <= SUBWAY_ROUTE_MATCH_RADIUS_METERS ? [...best.routes].sort() : [];
    if (routes.length > 0) matched++;

    points.push({ lat, lng, name: row[entranceSource.nameField] || null, routes });
  }

  console.log(
    `    route join: ${matched}/${points.length} subway entrances matched a station ` +
      `within ${SUBWAY_ROUTE_MATCH_RADIUS_METERS}m (${stations.length} stations with usable routes)`
  );

  return encodeBucket(points);
}

// --- bus (GTFS zips) ---------------------------------------------------------

function parseCsv(text) {
  // GTFS stops.txt: simple comma-separated with optional double-quoted
  // fields (which may themselves contain commas — handled, not assumed away).
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

/** trips.txt is small — trip_id -> route_id. Loaded whole, unlike stop_times.txt below. */
async function buildTripRouteMap(dir) {
  const text = await readFile(path.join(dir, "trips.txt"), "utf8");
  const [header, ...rows] = parseCsv(text);
  const tripIdx = header.indexOf("trip_id");
  const routeIdIdx = header.indexOf("route_id");
  const map = new Map();
  for (const cols of rows) {
    if (cols[tripIdx]) map.set(cols[tripIdx], cols[routeIdIdx]);
  }
  return map;
}

/** routes.txt is small — route_id -> the rider-facing short name (e.g. "M104"). */
async function buildRouteShortNameMap(dir) {
  const text = await readFile(path.join(dir, "routes.txt"), "utf8");
  const [header, ...rows] = parseCsv(text);
  const routeIdIdx = header.indexOf("route_id");
  const shortNameIdx = header.indexOf("route_short_name");
  const map = new Map();
  for (const cols of rows) {
    if (!cols[routeIdIdx]) continue;
    map.set(cols[routeIdIdx], cols[shortNameIdx] || cols[routeIdIdx]);
  }
  return map;
}

/**
 * stop_id -> Set<route short name>, built by STREAMING stop_times.txt
 * line-by-line — this file is one row per stop-VISIT (every trip's every
 * stop), not one row per stop, so it is far larger than stops/trips/routes.
 * Loading it whole (or into an array of parsed rows) risks real memory
 * pressure; only the accumulator map is kept, one line is read at a time,
 * and each line's parsed fields fall out of scope immediately after being
 * folded into it.
 */
async function buildStopRoutesMap(dir, tripToRoute, routeToShortName) {
  const stopRoutes = new Map();
  const rl = createInterface({
    input: createReadStream(path.join(dir, "stop_times.txt")),
    crlfDelay: Infinity,
  });

  let tripIdx = -1;
  let stopIdx = -1;
  let sawHeader = false;

  for await (const line of rl) {
    if (!line) continue;
    const [cols] = parseCsv(line);
    if (!cols) continue;

    if (!sawHeader) {
      tripIdx = cols.indexOf("trip_id");
      stopIdx = cols.indexOf("stop_id");
      sawHeader = true;
      continue;
    }

    const routeId = tripToRoute.get(cols[tripIdx]);
    if (!routeId) continue;
    const stopId = cols[stopIdx];
    const shortName = routeToShortName.get(routeId) ?? routeId;

    let set = stopRoutes.get(stopId);
    if (!set) {
      set = new Set();
      stopRoutes.set(stopId, set);
    }
    set.add(shortName);
  }

  return stopRoutes;
}

async function buildBusBucket(source) {
  const dir = await mkdtemp(path.join(tmpdir(), "amenity-gtfs-"));
  const seen = new Set();
  const points = [];
  try {
    for (const url of source.urls) {
      const label = url.split("/").pop();
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${label}: fetch failed (${res.status})`);
      const zipPath = path.join(dir, label);
      await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
      await execFileAsync("unzip", [
        "-o",
        "-q",
        zipPath,
        "stops.txt",
        "trips.txt",
        "routes.txt",
        "stop_times.txt",
        "-d",
        dir,
      ]);

      const [tripToRoute, routeToShortName] = await Promise.all([
        buildTripRouteMap(dir),
        buildRouteShortNameMap(dir),
      ]);
      const stopRoutes = await buildStopRoutesMap(dir, tripToRoute, routeToShortName);

      const text = await readFile(path.join(dir, "stops.txt"), "utf8");
      const [header, ...rows] = parseCsv(text);
      const latIdx = header.indexOf("stop_lat");
      const lngIdx = header.indexOf("stop_lon");
      const nameIdx = header.indexOf("stop_name");
      const stopIdIdx = header.indexOf("stop_id");

      let kept = 0;
      let routed = 0;
      for (const cols of rows) {
        const lat = Number(cols[latIdx]);
        const lng = Number(cols[lngIdx]);
        if (!inBounds(lat, lng)) continue;
        // Boroughs' feeds can overlap at edges — dedupe on rounded coordinate,
        // NOT stop_id, which is not guaranteed unique across the 5 feeds.
        const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const routeSet = stopRoutes.get(cols[stopIdIdx]);
        const routes = routeSet ? [...routeSet].sort() : [];
        if (routes.length > 0) routed++;

        points.push({ lat, lng, name: cols[nameIdx] || null, routes });
        kept++;
      }
      console.log(
        `    ${label}: ${rows.length} stops, ${kept} kept after dedup, ${routed} with route data`
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return encodeBucket(points);
}

// --- parks (Socrata MultiPolygon, split by typecategory) --------------------

async function buildParksBuckets(source) {
  const rows = await fetchAllSocrataRows(source.domain, source.datasetId);
  const byBucket = { park: [], playground: [], garden: [] };

  for (const row of rows) {
    const geometry = row[source.geometryField];
    if (!geometry?.coordinates?.length) continue;
    const centroid = multiPolygonCentroid(geometry.coordinates);
    if (!centroid || !inBounds(centroid.lat, centroid.lng)) continue;

    const bucket = PARKS_TYPECATEGORY_TO_BUCKET[row[source.typeField]] ?? "park";
    byBucket[bucket].push({
      lat: centroid.lat,
      lng: centroid.lng,
      name: row[source.nameField] || null,
    });
  }

  return Object.fromEntries(
    Object.entries(byBucket).map(([bucket, points]) => [bucket, encodeBucket(points)])
  );
}

// --- bikeShare (GBFS) ---------------------------------------------------------
//
// fetchBikeShareBucket lives in src/providers/amenities/bikeShare.js, not
// here — it is the ONE bucket the monthly cron route (routes/amenities.js)
// also refreshes live, and that route cannot import from scripts/. One
// function, two callers.

// --- bikeLane / protectedLane (Socrata MultiLineString, densified) ----------

async function buildBikeLaneBuckets(source) {
  const rows = await fetchAllSocrataRows(source.domain, source.datasetId);
  const byBucket = { bikeLane: [], protectedLane: [] };

  for (const row of rows) {
    const cls = row[source.classField];
    const bucket = source.protectedClasses.includes(cls)
      ? "protectedLane"
      : source.laneClasses.includes(cls)
        ? "bikeLane"
        : null;
    if (!bucket) continue; // "L" (Link) and anything unrecognised — excluded

    const geometry = row[source.geometryField];
    const lines = geometry?.coordinates ?? [];
    const name = row.street || null;
    for (const line of lines) {
      for (const [lng, lat] of densifyLine(line, AMENITY_LANE_SPACING_METERS)) {
        if (!inBounds(lat, lng)) continue;
        byBucket[bucket].push({ lat, lng, name });
      }
    }
  }

  return Object.fromEntries(
    Object.entries(byBucket).map(([bucket, points]) => [bucket, encodeBucket(points)])
  );
}

// --- sanity guard -------------------------------------------------------------

async function loadCommitted(filename) {
  const filePath = path.join(OUTPUT_DIR, filename);
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, "utf8"));
}

function checkSanity(filename, previous, next) {
  if (!previous) return; // first-ever build — nothing to compare against
  for (const [bucket, data] of Object.entries(next)) {
    const before = previous[bucket]?.n ?? 0;
    if (before === 0) continue;
    if (data.n < before * SANITY_GUARD_MIN_SHARE) {
      throw new Error(
        `${filename}: bucket "${bucket}" dropped from ${before} to ${data.n} points ` +
          `(more than ${(1 - SANITY_GUARD_MIN_SHARE) * 100}% below committed) — ` +
          `refusing to write. Looks like a truncated fetch, not a real dataset shrink.`
      );
    }
  }
}

// --- run -----------------------------------------------------------------------

console.log("=== transit ===");
const [subway, rail, bus] = await Promise.all([
  (async () => {
    console.log("  fetching subway entrances + station routes...");
    return buildSubwayBucketWithRoutes(AMENITY_SOURCES.subway, AMENITY_SOURCES.subwayStations);
  })(),
  buildPointBucket(AMENITY_SOURCES.rail),
  (async () => {
    console.log("  fetching bus GTFS (5 boroughs)...");
    return buildBusBucket(AMENITY_SOURCES.bus);
  })(),
]);
const transit = { subway, rail, bus };

console.log("=== parks ===");
const parks = await buildParksBuckets(AMENITY_SOURCES.parks);

console.log("=== bike ===");
const [bikeShare, bikeLanes] = await Promise.all([
  fetchBikeShareBucket(),
  buildBikeLaneBuckets(AMENITY_SOURCES.bikeLane),
]);
const bike = { bikeShare, ...bikeLanes };

const outputs = {
  "transit.json": transit,
  "parks.json": parks,
  "bike.json": bike,
};

console.log("\n=== Summary ===");
console.log(
  `  ${"bucket".padEnd(16)} ${"points".padStart(8)} ${"named".padStart(8)} ${"routed".padStart(8)}`
);
for (const [file, doc] of Object.entries(outputs)) {
  console.log(`  -- ${file}`);
  for (const [bucket, data] of Object.entries(doc)) {
    const routed = data.routeIdx ? data.routeIdx.filter((idx) => idx !== -1).length : "-";
    console.log(
      `  ${bucket.padEnd(16)} ${String(data.n).padStart(8)} ${String(data.names.length).padStart(8)} ${String(routed).padStart(8)}`
    );
  }
}

const previous = Object.fromEntries(
  await Promise.all(Object.keys(outputs).map(async (f) => [f, await loadCommitted(f)]))
);
for (const [file, doc] of Object.entries(outputs)) {
  checkSanity(file, previous[file], doc);
}

if (DRY_RUN) {
  console.log("\n--dry-run: nothing written.");
} else {
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const [file, doc] of Object.entries(outputs)) {
    await writeFile(path.join(OUTPUT_DIR, file), `${JSON.stringify(doc)}\n`);
    console.log(`Wrote src/config/amenities/${file} — COMMIT THIS FILE.`);
  }
}
