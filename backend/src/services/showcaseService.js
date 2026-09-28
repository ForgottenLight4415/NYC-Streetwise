import {
  SHOWCASE_CANDIDATE_FACTOR,
  SHOWCASE_MAX_LIMIT,
} from "../config/constants.js";
import { SHOWCASE_ADDRESSES, randomShowcaseAddress } from "../config/showcase.js";
import { boroughFor } from "../lib/borough.js";
import {
  ensureAddressLookupIndexes,
  recentLookups,
  recordCurated,
  sampleLookups,
  topLookups,
} from "../providers/addressDirectory.js";
import { buildCachedScoreReport, getCounts } from "./scoreService.js";

// Joins the address directory to the counts cache to produce named, scored
// addresses for the homepage.
//
// The one hard rule: NOTHING here may touch Socrata on a read path. The
// homepage's three address sections (the "Try" chips, the hero card, the
// carousel) are above or near the fold, and an uncached score costs 0.3-2.5s
// with an observed 8.3s tail. So a read returns what is cached and says nothing
// about the rest — never fewer facts than we have, never a number we invented.
//
// Two collections have to agree for one card to exist: `address_lookups` knows
// the address text (no TTL), `complaint_cache` knows the counts (24h TTL). A row
// whose counts have expired is skipped, which is why candidates are over-fetched.

/**
 * Reads directory rows in the order the requested mode implies.
 *
 * `random` deliberately samples MORE than it needs and lets the caller take the
 * first scored one: a single $sample that happened to land on an expired row
 * would send the hero card down its slow live-fetch path while perfectly good
 * cached addresses sat unused.
 */
function candidatesFor(mode, limit) {
  const size = Math.min(limit * SHOWCASE_CANDIDATE_FACTOR, SHOWCASE_MAX_LIMIT * SHOWCASE_CANDIDATE_FACTOR);
  if (mode === "recent") return recentLookups(size);
  if (mode === "random") return sampleLookups(size);
  return topLookups(size);
}

/**
 * Named, scored, currently-cached addresses for the homepage.
 *
 * Scores every candidate in parallel — each is a cache read plus arithmetic, so
 * the whole set costs about as long as its slowest Mongo round trip — then drops
 * the ones whose counts have expired and returns at most `limit`.
 *
 * Returns fewer items than asked for, or none at all, rather than reaching
 * upstream to fill the gap. Callers must render whatever they get.
 *
 * @returns {Promise<Array<object>>} each item is the POST /api/score payload
 *   (buildingHealth, blockQuality, meta) plus address, borough, lat, lng,
 *   lookups, lastSeenAt and curated.
 */
/**
 * A named address for a caller that got no items back.
 *
 * Curated, coordinates committed, and picked at random — so a cold homepage is
 * not always fronted by the same building. Carries no scores: whoever needs them
 * fetches them live, which is a decision only the caller can make, since it is
 * the one slow thing on that page.
 */
export function showcaseFallback() {
  const entry = randomShowcaseAddress();
  return {
    address: entry.address,
    borough: boroughFor(entry.address, entry.lat, entry.lng),
    lat: entry.lat,
    lng: entry.lng,
  };
}

export async function buildShowcase({ limit, mode }) {
  const candidates = await candidatesFor(mode, limit);
  if (candidates.length === 0) return [];

  const scored = await Promise.all(
    candidates.map(async (row) => {
      // buildCachedScoreReport never throws for a cache miss — it returns null —
      // but a genuine Mongo fault would surface here, and one bad row must not
      // empty the homepage. Treated as "not available", same as an expired row.
      const data = await buildCachedScoreReport(row.lat, row.lng).catch((err) => {
        console.warn("[showcase] scoring failed, skipping row:", err.message);
        return null;
      });
      if (!data) return null;
      return {
        ...data,
        // AFTER the spread, deliberately: a score report carries `address: null`
        // because /api/score is coordinate-only, and the directory row is the
        // only thing that knows the name. Spreading last would blank it again.
        address: row.address,
        borough: row.borough ?? boroughFor(row.address, row.lat, row.lng),
        lat: row.lat,
        lng: row.lng,
        lookups: row.lookups ?? 0,
        lastSeenAt: row.lastSeenAt ?? null,
        curated: Boolean(row.curated),
      };
    })
  );

  return scored.filter(Boolean).slice(0, limit);
}

/**
 * Fetches and caches the curated set, so the homepage has real addresses to show
 * on a cold cache.
 *
 * This is the ONE place in the showcase code that talks to Socrata, and it is
 * never on a user's path — it runs from `npm run warm:showcase` or the daily
 * cron. Every entry is also written into the directory as `curated`, without
 * touching its lookup counter, so genuine traffic always outranks the seeds.
 *
 * Sequential, not parallel: eight addresses are sixteen Socrata calls, and the
 * same politeness that caps BASELINE_SAMPLE_CONCURRENCY applies here. One
 * address failing does not stop the rest — a partial warm is strictly better
 * than none.
 *
 * SCOPE — DO NOT WIDEN. This iterates SHOWCASE_ADDRESSES, a fixed committed list
 * of eight, and nothing else. It must never be pointed at `address_lookups`,
 * however tempting that looks: the directory grows without bound with real
 * traffic and has no TTL, so warming it would mean two live Socrata calls per
 * address ever searched, on a daily schedule, forever. At the measured ~7.8s per
 * address that is 20 minutes of upstream calls per thousand rows — past any
 * serverless execution cap, and rude to an API we do not pay for.
 *
 * The homepage does not need it either. It shows at most a dozen cards, real
 * lookups are already cached by the report that created them, and anything that
 * has expired should expire — a stale address nobody has visited in 24h has no
 * claim on the front page. If more addresses are wanted on the homepage, add
 * them to SHOWCASE_ADDRESSES; do not change what this loops over.
 *
 * @returns {Promise<{warmed: number, failed: number, results: Array}>}
 */
export async function warmShowcase({ onProgress } = {}) {
  const results = [];

  // Belt and braces, not the mechanism: recordCurated() below builds these
  // itself, as does every other read and write of the directory. This used to be
  // the only path in production that created them, which made warming
  // load-bearing for something unrelated to warming. Kept because it costs one
  // memoized call and puts the build before the loop rather than inside it.
  await ensureAddressLookupIndexes().catch((err) =>
    console.warn("[showcase] index setup failed, continuing:", err.message)
  );

  for (const entry of SHOWCASE_ADDRESSES) {
    const borough = boroughFor(entry.address, entry.lat, entry.lng);
    await recordCurated({ ...entry, borough });

    try {
      // forceRefresh, even though these are usually already cached, and that is
      // the whole point: a cache HIT performs no write, so createdAt is not
      // touched and the document still expires 24h after it was last fetched.
      // Only a write slides the TTL. Re-fetching is therefore what keeps a daily
      // cron effective — and it costs the freshest counts rather than stale ones.
      const { cache } = await getCounts(entry.lat, entry.lng, { forceRefresh: true });
      results.push({ address: entry.address, ok: true, cache });
    } catch (err) {
      results.push({ address: entry.address, ok: false, error: err.message });
    }

    onProgress?.(results[results.length - 1]);
  }

  return {
    warmed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
