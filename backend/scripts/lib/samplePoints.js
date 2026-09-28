/**
 * Load-or-draw for the committed baseline sample coordinates.
 *
 * WHY THIS EXISTS. BASELINE_SAMPLE_SEED is documented as making a rerun pick
 * the same coordinates, "so it hits the cache instead of paying for 500 fresh
 * Socrata calls". The seed alone cannot deliver that, for three compounding
 * reasons — all of them in sampleCoords.js and all of them deliberate:
 *
 *   1. candidateCoords() derives its random date slices from Date.now() and a
 *      cutoff computed from TODAY, so the window it draws from slides daily.
 *      The same seed therefore picks the same *fractions* of a different
 *      window every day.
 *   2. The candidate query is deliberately UNORDERED ($order was measured at
 *      9.7s against 0.23s), so Socrata is free to return different rows for
 *      the same query.
 *   3. The complaint cache a rerun was supposed to hit expires after 24h.
 *
 * So the points were re-drawn on every run, the sampling step cost 25
 * sequential Socrata calls before any measuring began, and two baselines built
 * a week apart described different places — which is exactly the property a
 * fixed seed was supposed to buy.
 *
 * Committing the drawn points fixes all three: reruns are genuinely
 * reproducible, the sampling calls disappear, and the complaint and amenity
 * baselines can be made to describe the same coordinates.
 *
 * DRAWING IS STILL THE SOURCE OF TRUTH — this only caches the result. Pass
 * `--resample` to redraw and overwrite, which is the right move whenever the
 * sampling parameters change (BASELINE_SAMPLE_SIZE, the thinning grid, the
 * borough floor) or enough time has passed that the frozen set no longer
 * represents where complaints are filed. The stored file records when and with
 * what it was drawn so that judgement can be made from the file itself.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * @param {string} filePath committed JSON to read
 * @param {object} expect `{ sampleSize, seed, keys }` the caller is about to
 *   use — a stored set drawn under different parameters is NOT silently
 *   reused, since it would no longer be the sample the caller asked for.
 *   `keys` names the groups the caller will index into (e.g. the radius tiers),
 *   so a truncated file is rejected here rather than throwing downstream on an
 *   undefined array.
 * @returns {Promise<Record<string, {lat:number,lng:number,borough:string}[]>|null>}
 *   the stored `samples` map, or null to draw fresh.
 */
export async function loadSamplePoints(filePath, { sampleSize, seed, keys = [] }) {
  const raw = await readFile(filePath, "utf8").catch(() => null);
  if (raw === null) return null;

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.warn(`[sample] ${path.basename(filePath)} is not valid JSON — redrawing.`);
    return null;
  }

  if (doc?.sampleRequested !== sampleSize || doc?.seed !== seed) {
    console.warn(
      `[sample] ${path.basename(filePath)} was drawn for ` +
        `samples=${doc?.sampleRequested} seed=${doc?.seed}, but this run wants ` +
        `samples=${sampleSize} seed=${seed} — redrawing.`
    );
    return null;
  }

  const samples = doc.samples;
  const missing = keys.filter((key) => !samples?.[key]);
  if (missing.length > 0) {
    console.warn(
      `[sample] ${path.basename(filePath)} has no points for ${missing.join(", ")} — redrawing.`
    );
    return null;
  }

  const usable =
    samples &&
    typeof samples === "object" &&
    Object.keys(samples).length > 0 &&
    Object.values(samples).every(
      (points) =>
        Array.isArray(points) &&
        points.length > 0 &&
        points.every((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
    );

  if (!usable) {
    console.warn(`[sample] ${path.basename(filePath)} is malformed or empty — redrawing.`);
    return null;
  }

  const total = Object.values(samples).reduce((n, points) => n + points.length, 0);
  console.log(
    `Reusing ${total} committed sample coordinates from ${path.basename(filePath)} ` +
      `(drawn ${doc.drawnAt ?? "unknown"}). Pass --resample to redraw.`
  );
  return samples;
}

/** Writes the drawn points so the next run reuses them. Never throws the run. */
export async function saveSamplePoints(filePath, samples, { sampleSize, seed }) {
  const doc = {
    // Recorded so loadSamplePoints can refuse a set drawn under parameters
    // that no longer match, rather than quietly reusing the wrong sample.
    sampleRequested: sampleSize,
    seed,
    drawnAt: new Date().toISOString(),
    samples,
  };
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`\nWrote ${filePath} — COMMIT THIS FILE so reruns are reproducible.`);
    return true;
  } catch (err) {
    console.warn(`[sample] could not write ${filePath}: ${err.message}`);
    return false;
  }
}
