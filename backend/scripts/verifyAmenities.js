/**
 * Verifies AMENITY_SOURCES (constants.js) against the live APIs — the amenity
 * scores' analogue of scripts/verifyDataset.js, and the same house convention:
 * an "OPEN ITEMS — verify before building on top" check, re-runnable if a
 * source ever moves or a build starts producing suspiciously thin output.
 *
 *   npm run verify:amenities
 *
 * Confirms, for every AMENITY_SOURCES entry: the source resolves, its actual
 * field names, its row count, and the share of rows with usable geometry.
 * Prints a report; makes no assertions and writes nothing — scripts/
 * buildAmenities.js is the one that writes committed output, and only after
 * this passes.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AMENITY_SOURCES, NYC_BOUNDS } from "../src/config/constants.js";

const execFileAsync = promisify(execFile);

function inBounds(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= NYC_BOUNDS.minLat &&
    lat <= NYC_BOUNDS.maxLat &&
    lng >= NYC_BOUNDS.minLng &&
    lng <= NYC_BOUNDS.maxLng
  );
}

async function socrataQuery(domain, datasetId, params) {
  const res = await fetch(
    `https://${domain}/resource/${datasetId}.json?${new URLSearchParams(params)}`
  );
  if (!res.ok) {
    throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// --- Socrata point/polygon/line sources --------------------------------------

async function verifySocrataSource(name, source) {
  console.log(`\n=== ${name} (Socrata ${source.domain}/${source.datasetId}) ===`);

  const [{ count }] = await socrataQuery(source.domain, source.datasetId, {
    $select: "count(*)",
  });
  console.log(`  row count: ${count}`);

  const rows = await socrataQuery(source.domain, source.datasetId, { $limit: "500" });
  console.log(`  fields: ${Object.keys(rows[0] ?? {}).join(", ")}`);

  let usable = 0;
  for (const row of rows) {
    if (source.latField && source.lngField) {
      if (inBounds(Number(row[source.latField]), Number(row[source.lngField]))) usable++;
    } else if (source.geometryField) {
      if (row[source.geometryField]?.coordinates?.length) usable++;
    }
  }
  console.log(
    `  usable geometry (sample of ${rows.length}): ${usable} (${(
      (100 * usable) /
      rows.length
    ).toFixed(1)}%)`
  );

  if (source.typeField) {
    const byType = new Map();
    for (const row of rows) {
      const key = row[source.typeField] ?? "(none)";
      byType.set(key, (byType.get(key) ?? 0) + 1);
    }
    console.log(`  ${source.typeField} breakdown (sample): ${JSON.stringify(Object.fromEntries(byType))}`);
  }

  if (source.classField) {
    const byClass = new Map();
    for (const row of rows) {
      const key = row[source.classField] ?? "(none)";
      byClass.set(key, (byClass.get(key) ?? 0) + 1);
    }
    console.log(`  ${source.classField} breakdown (sample): ${JSON.stringify(Object.fromEntries(byClass))}`);
  }

  if (source.railroadField) {
    const [byRailroad] = [
      await socrataQuery(source.domain, source.datasetId, {
        $select: `${source.railroadField}, count(*)`,
        $group: source.railroadField,
      }),
    ];
    console.log(`  ${source.railroadField} breakdown: ${JSON.stringify(byRailroad)}`);
  }
}

// --- GTFS zip sources (bus) ---------------------------------------------------

async function verifyGtfsZipSource(name, source) {
  console.log(`\n=== ${name} (GTFS zip, ${source.urls.length} feeds) ===`);

  const dir = await mkdtemp(path.join(tmpdir(), "amenity-gtfs-"));
  let total = 0;
  let usable = 0;
  try {
    for (const url of source.urls) {
      const label = url.split("/").pop();
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        console.log(`  ${label}: FETCH FAILED (${res.status})`);
        continue;
      }
      const zipPath = path.join(dir, label);
      await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

      await execFileAsync("unzip", ["-o", "-q", zipPath, "stops.txt", "-d", dir]);
      const text = await readFile(path.join(dir, "stops.txt"), "utf8");
      const lines = text.trim().split("\n");
      const header = lines[0].split(",");
      const latIdx = header.indexOf("stop_lat");
      const lngIdx = header.indexOf("stop_lon");

      let feedUsable = 0;
      for (const line of lines.slice(1)) {
        const cols = line.split(",");
        if (inBounds(Number(cols[latIdx]), Number(cols[lngIdx]))) feedUsable++;
      }
      const feedTotal = lines.length - 1;
      console.log(`  ${label}: ${feedTotal} stops, ${feedUsable} in-bounds`);
      total += feedTotal;
      usable += feedUsable;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`  TOTAL: ${total} stops across all boroughs, ${usable} usable (${((100 * usable) / total).toFixed(1)}%)`);
  console.log(
    `  Note: stop_id is not guaranteed globally unique across the 5 borough feeds — dedupe by (lat,lng) rounded, not by stop_id, when building.`
  );
}

// --- GBFS sources (bikeShare) -------------------------------------------------

async function verifyGbfsSource(name, source) {
  console.log(`\n=== ${name} (GBFS, ${source.url}) ===`);
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${res.status} fetching ${source.url}`);
  const data = await res.json();
  const stations = data?.data?.stations ?? [];
  console.log(`  station count: ${stations.length}`);
  console.log(`  fields: ${Object.keys(stations[0] ?? {}).join(", ")}`);
  const usable = stations.filter((s) => inBounds(Number(s.lat), Number(s.lon))).length;
  console.log(`  usable geometry: ${usable} (${((100 * usable) / stations.length).toFixed(1)}%)`);
}

// --- Run -----------------------------------------------------------------------

for (const [name, source] of Object.entries(AMENITY_SOURCES)) {
  if (source.kind === "socrata") await verifySocrataSource(name, source);
  else if (source.kind === "gtfs-zip") await verifyGtfsZipSource(name, source);
  else if (source.kind === "gbfs") await verifyGbfsSource(name, source);
}
