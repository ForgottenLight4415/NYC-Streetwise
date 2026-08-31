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
 * COMPLEX ID (transit.subway ONLY): a third, equally additive pair,
 * `complexIds`/`complexIdIdx`, same shape/semantics as `routeSets`/`routeIdx`
 * above — the official MTA station-complex identifier each subway entrance
 * belongs to, read straight off the source dataset (no join). Lets
 * amenityService.js group individual entrances back into whole complexes at
 * query time — see buildSubwayBucket below and CLAUDE.md's complex-
 * clustering note.
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
  BUS_STOP_CLUSTER_RADIUS_METERS,
  PARKS_TYPECATEGORY_TO_BUCKET,
  SOCRATA_ROW_LIMIT,
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

// --- subway (i9wp-a4ja entrances only) --------------------------------------
//
// The entrance dataset already carries the complex-level truth on every
// row — `complex_id` (the official MTA grouping riders think of as "one
// station"; two adjacent-but-separately-tracked complexes like Herald Sq's
// 6th Ave and Broadway sides both use it) and `daytime_routes` already
// scoped to that whole complex. No second dataset, no proximity join.
//
// Grouping is by complex_id, but the NAME and ROUTES written for every point
// under one complex_id are canonicalized (most-common value across that
// complex's rows, first-seen breaking ties) rather than trusted per-row —
// MTA's own data has minor variance across entrances at the same complex
// (confirmed live: "34 St-Herald Sq" and "34 St-Herald Square" both under
// complex_id 607).
//
// GEOGRAPHIC OUTLIER GUARD — this is load-bearing, not defensive
// programming for a hypothetical: confirmed live, complex_id 607 (Herald
// Sq's own id) also has 4 rows whose `stop_name` is "14 St-Union Sq" at
// Union Square's REAL coordinates, ~1.9km from Herald Sq — MTA's own
// entrance-to-complex_id assignment is wrong for these specific rows, not a
// one-off. Trusting complex_id blindly would silently relabel a Union
// Square entrance as Herald Sq (and vice versa: Herald Sq entrances would
// pull Union Sq's routes into their canonical vote). Any entrance more than
// COMPLEX_OUTLIER_METERS from its claimed complex's OTHER entrances'
// centroid is excluded from that complex's name/route vote AND does not
// inherit the complex's canonical values — it keeps its OWN row's
// (confirmed reliable) name and routes instead, and gets no complexId, so
// it becomes its own single-entrance group downstream rather than
// corrupting — or being corrupted by — an unrelated complex.

/** No real MTA complex spans anywhere near this; two "entrances" farther
 *  apart than this cannot be the same physical station. */
const COMPLEX_OUTLIER_METERS = 1000;

/** The most frequent key in a Map<key, count>, first-seen breaking ties. */
function mostCommon(counts) {
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

async function buildSubwayBucket(source) {
  const rows = await fetchAllSocrataRows(source.domain, source.datasetId);

  // Pass 1: parse every in-bounds row once, and collect coordinates per
  // complex_id for the outlier check below.
  const parsed = [];
  const complexCoords = new Map(); // complexId -> [{lat, lng}, ...]
  for (const row of rows) {
    const lat = Number(row[source.latField]);
    const lng = Number(row[source.lngField]);
    if (!inBounds(lat, lng)) continue;

    const complexId = row[source.complexIdField] || null;
    const name = row[source.nameField] || null;
    const routesStr = String(row[source.routesField] || "").trim();
    parsed.push({ lat, lng, complexId, name, routesStr });

    if (complexId) {
      if (!complexCoords.has(complexId)) complexCoords.set(complexId, []);
      complexCoords.get(complexId).push({ lat, lng });
    }
  }

  const complexCentroids = new Map();
  for (const [complexId, coords] of complexCoords) {
    complexCentroids.set(complexId, {
      lat: coords.reduce((sum, c) => sum + c.lat, 0) / coords.length,
      lng: coords.reduce((sum, c) => sum + c.lng, 0) / coords.length,
    });
  }
  for (const p of parsed) {
    const centroid = p.complexId ? complexCentroids.get(p.complexId) : null;
    p.isOutlier = centroid ? haversineMeters(p.lat, p.lng, centroid.lat, centroid.lng) > COMPLEX_OUTLIER_METERS : false;
  }

  // Pass 2: tally name/routes strings per complex_id, outliers excluded —
  // an outlier's own (wrong) location must not drag the REST of its
  // claimed complex's canonical vote off course either.
  const nameCounts = new Map(); // complexId -> Map<name, count>
  const routeCounts = new Map(); // complexId -> Map<"B D F M", count>
  for (const p of parsed) {
    if (!p.complexId || p.isOutlier) continue;
    if (p.name) {
      const counts = nameCounts.get(p.complexId) ?? new Map();
      counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
      nameCounts.set(p.complexId, counts);
    }
    if (p.routesStr) {
      const counts = routeCounts.get(p.complexId) ?? new Map();
      counts.set(p.routesStr, (counts.get(p.routesStr) ?? 0) + 1);
      routeCounts.set(p.complexId, counts);
    }
  }

  const canonicalName = new Map();
  for (const [complexId, counts] of nameCounts) {
    canonicalName.set(complexId, mostCommon(counts));
  }
  const canonicalRoutes = new Map();
  for (const [complexId, counts] of routeCounts) {
    const routesStr = mostCommon(counts);
    canonicalRoutes.set(
      complexId,
      routesStr
        .split(/\s+/)
        .map((r) => r.trim())
        .filter(Boolean)
        .sort()
    );
  }

  // Pass 3: one point per entrance. A non-outlier inherits its complex's
  // canonical name/routes; an outlier (or an entrance with no complex_id at
  // all) falls back to its own row's values and no complexId.
  const points = [];
  let routed = 0;
  let outliers = 0;
  for (const p of parsed) {
    let name;
    let routes;
    let complexId;
    if (p.complexId && !p.isOutlier) {
      name = canonicalName.get(p.complexId) ?? p.name;
      routes = canonicalRoutes.get(p.complexId) ?? [];
      complexId = p.complexId;
    } else {
      name = p.name;
      routes = p.routesStr
        ? p.routesStr
            .split(/\s+/)
            .map((r) => r.trim())
            .filter(Boolean)
            .sort()
        : [];
      complexId = null;
      if (p.isOutlier) outliers++;
    }
    if (routes.length > 0) routed++;
    points.push({ lat: p.lat, lng: p.lng, name, routes, complexId });
  }

  console.log(
    `    ${points.length} subway entrances across ${canonicalName.size} complexes, ` +
      `${routed} with route data` +
      (outliers > 0
        ? `, ${outliers} excluded as complex_id outliers (>${COMPLEX_OUTLIER_METERS}m from their claimed complex)`
        : "")
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

/**
 * Physical-pole clustering: the GTFS feed gives every route its own stop
 * record even when several routes (e.g. M1/M2/M3/M4) board from the same
 * curb, so raw stops.txt rows over-count "places to catch a bus" relative to
 * what a rider standing there actually sees. Groups points within
 * `radiusMeters` of each other transitively (a flood-fill, not just each
 * point's immediate neighbors, so a short chain of stops each ~5m apart all
 * end up in one cluster) and merges each group into one point with a
 * unioned route list.
 *
 * Grid-bucketed first, the same cell-hash idea spatialIndex.js's buildIndex
 * uses for its query-time index — built once here instead of queried
 * repeatedly — so this stays fast at bus-stop-corpus scale (~11k points)
 * instead of degrading to the O(n²) a naive pairwise scan would be.
 *
 * @returns {number[][]} arrays of indices into `points`, one per cluster.
 */
function clusterNearbyPoints(points, radiusMeters) {
  const gridDegrees = radiusMeters / 111320; // ~meters per degree of latitude
  const cells = new Map();
  points.forEach((p, i) => {
    const key = `${Math.floor(p.lat / gridDegrees)},${Math.floor(p.lng / gridDegrees)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  });

  const visited = new Array(points.length).fill(false);
  const clusters = [];

  for (let i = 0; i < points.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const members = [i];
    const queue = [i];

    while (queue.length > 0) {
      const cur = queue.pop();
      const row = Math.floor(points[cur].lat / gridDegrees);
      const col = Math.floor(points[cur].lng / gridDegrees);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const cell = cells.get(`${row + dr},${col + dc}`);
          if (!cell) continue;
          for (const j of cell) {
            if (visited[j]) continue;
            if (haversineMeters(points[cur].lat, points[cur].lng, points[j].lat, points[j].lng) <= radiusMeters) {
              visited[j] = true;
              members.push(j);
              queue.push(j);
            }
          }
        }
      }
    }
    clusters.push(members);
  }

  return clusters;
}

/**
 * Merges one cluster's member points into a single pole: routes = the union
 * of every member's routes (sorted), name = whichever member's name is most
 * common in the cluster, position = the member closest to the cluster's own
 * centroid — a real stop's coordinates, not a synthetic average that could
 * land in the middle of an intersection.
 */
function mergeCluster(points, memberIndices) {
  const members = memberIndices.map((i) => points[i]);

  const centroidLat = members.reduce((sum, p) => sum + p.lat, 0) / members.length;
  const centroidLng = members.reduce((sum, p) => sum + p.lng, 0) / members.length;
  let closest = members[0];
  let closestMeters = Infinity;
  for (const p of members) {
    const meters = haversineMeters(p.lat, p.lng, centroidLat, centroidLng);
    if (meters < closestMeters) {
      closestMeters = meters;
      closest = p;
    }
  }

  const nameCounts = new Map();
  const routeSet = new Set();
  for (const p of members) {
    if (p.name) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
    for (const route of p.routes ?? []) routeSet.add(route);
  }

  return {
    lat: closest.lat,
    lng: closest.lng,
    name: mostCommon(nameCounts),
    routes: [...routeSet].sort(),
  };
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

  const clusters = clusterNearbyPoints(points, BUS_STOP_CLUSTER_RADIUS_METERS);
  const poles = clusters.map((members) => mergeCluster(points, members));
  console.log(
    `    bus: ${points.length} deduped stops -> ${poles.length} physical poles ` +
      `after ${BUS_STOP_CLUSTER_RADIUS_METERS}m clustering`
  );

  return encodeBucket(poles);
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
    console.log("  fetching subway entrances...");
    return buildSubwayBucket(AMENITY_SOURCES.subway);
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
