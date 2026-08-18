/**
 * Pre-warms the curated showcase set against the LIVE Socrata API.
 *
 *   npm run warm:showcase
 *
 * The homepage shows only cached scores — no fabricated ones, and nothing fetched
 * on the render path. So on a cold cache it has real but sparse content until
 * somebody runs a report. This fills it: sixteen Socrata calls (two tiers x eight
 * addresses) written into complaint_cache, plus a directory row per address so
 * each cached coordinate can be named.
 *
 * Run it before a demo. In production the same routine runs daily via GET
 * /api/warm (see vercel.json crons), which is what holds the sliding 24h TTL
 * open — a cache hit performs no write and so does not extend it.
 *
 * Requires a real MONGODB_URI: warming an in-memory database would achieve
 * nothing, unlike verifyCache.js which is testing the mechanism rather than
 * populating anything.
 */

import { warmShowcase } from "../src/services/showcaseService.js";
import { SHOWCASE_ADDRESSES } from "../src/config/showcase.js";
import { closeMongo, isMongoConfigured } from "../src/providers/mongo.js";

if (!isMongoConfigured()) {
  console.error(
    "No usable MONGODB_URI. Warming writes to the cache, so there is nothing " +
      "to warm without one — set MONGODB_URI (Atlas for production, the local " +
      "docker mongod for dev) and run again."
  );
  process.exit(1);
}

console.log(`Warming ${SHOWCASE_ADDRESSES.length} curated addresses.\n`);
const startedAt = Date.now();

const { warmed, failed, results } = await warmShowcase({
  onProgress: (result) => {
    if (result.ok) {
      const tiers = Object.entries(result.cache)
        .map(([tier, state]) => `${tier}=${state}`)
        .join(" ");
      console.log(`  ok    ${result.address}  (${tiers})`);
    } else {
      console.log(`  FAIL  ${result.address}  ${result.error}`);
    }
  },
});

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n${warmed} warmed, ${failed} failed, ${seconds}s.`);

await closeMongo();

// Exit 1 on ANY failure, not only on a total one: a partly-warm showcase renders
// fine, but a cron that quietly half-succeeds every night is worth noticing.
if (failed > 0) {
  console.error(
    "Some addresses did not warm. Socrata's spatial filter is erratic " +
      "(measured 0.4-33.1s cold) — rerun before assuming a real fault."
  );
  process.exit(1);
}
console.log("Showcase is warm. The homepage will render these from cache.");
process.exit(0);
