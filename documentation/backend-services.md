# Backend — Services (`backend/src/services/`)

## `scoreService.js` — orchestration

The only layer that coordinates cache + Socrata + baseline + amenities +
scoring. Routes call into this; this never touches Express, and providers
never call each other directly except through here.

- **`getCounts(lat, lng, { now, tiers, forceRefresh })`** — bucket counts for
  both complaint radius tiers around one point. Rounds the coordinate to the
  cache-key precision first (~11m) — **the rounded coordinate is what's
  queried**, so a cache hit and a cache miss for the "same" address always
  describe the same circle. Reads whatever's cached, fetches the rest from
  Socrata in parallel via `Promise.allSettled` (a rejection in one tier must
  not discard a successful write in the other), writes fetched tiers back.
- **`buildScoreReport(lat, lng, options)`** — the full `POST /api/score`
  payload. In mock mode, short-circuits to `mockData.js` with no network at
  all. Otherwise runs `getCounts()`, `loadBaseline()`, and
  `amenityService.getAmenityMetrics()`/`getWalkabilityMetrics()` together,
  then feeds everything into `scoring.js#buildReport()` plus the deterministic
  `summary` template from `explain.js`.
- **`buildCachedScoreReport(lat, lng, options)`** — the homepage/showcase
  render path. Must stay fast and free: always passes `cacheOnly: true`
  through to the amenity/walkability lookups, so a cache miss there returns
  the section omitted rather than triggering a live, billed call.
- **`buildExplanation(lat, lng)`** — backs `GET /api/explanation?tier=overall`.
  The one function in the app that calls the AI adapter; see `explain.js`
  below for the caching/staleness logic.
- **`fetchComplaintPoints` / `fetchComplaintGroupList` / `fetchComplaintGroupDetail`**
  — back `/api/complaints` (raw and grouped modes) and `/api/complaints/group`.
  Not cached at the row level for the raw mode (the cache stores bucket
  counts, not individual rows); the grouped mode has its own
  `complaint_groups_cache` collection, keyed by `{lat, lng, radiusTier}` with
  no `months` dimension, since a shorter window is always a prefix of the
  cached full window.
- **`fetchTrend(lat, lng, radiusMeters, { tier, months, now })`** — backs
  `GET /api/trend`; see [`backend-routes.md`](./backend-routes.md#get-apitrend--trendjs)
  for why this exists as its own endpoint rather than being derived from
  `/api/complaints`.
- **`isMockMode()`** — `true` when `USE_MOCK_DATA` is `"1"`/`"true"`. Read at
  *call time*, not import time, so mock mode can be toggled without
  re-importing the module.

---

## `scoring.js` — the scoring algorithm (pure function)

No network, no Mongo, no clock — everything here is a function of its
arguments, which is what makes the whole model testable against fixed
fixtures. Shared, unmodified, by both the complaint tiers and the amenity
tiers — an amenity's "distance to nearest" is scored by the exact same
lower-is-better curve as a complaint count.

### Why percentile-against-a-baseline, not raw counts

> "47 noise complaints" means nothing to a renter. "Quieter than 78% of NYC"
> does.

Each bucket's raw value (a complaint count, or a distance in meters for an
amenity bucket) is converted to *where it sits in the citywide distribution*
for that bucket, then inverted so lower is always better.

### The percentile curve — `anchorsFor()` + `percentileFor()`

Four anchor points `[value, percentile]` define a piecewise-linear curve per
bucket:

1. **`[0, 0]`** — a zero count (or zero distance) is always the best
   possible reading, before the zero-tie adjustment below.
2. **The zero-tie ceiling** — real-world distributions here are heavily
   zero-inflated (e.g. ~45% of sampled buildings have zero heat complaints).
   All of those are *tied* at zero, and ties resolve to the **most
   favorable** percentile in the tie — otherwise a zero count would inherit
   the tie's median and score ~50 instead of 100. `zeroShare` anchors
   `[1, zeroShare × 100]`, so the first unit above zero starts scoring from
   the top of that tie.
3. **`[median, 50]`** and **`[p90, 90]`** — the two real baseline data points.
4. **The tail** — above `p90` the baseline says nothing about shape, so the
   curve extrapolates to `100` at `p90 + SCORE_TAIL_MULTIPLIER × (p90 − median)`
   (multiplier 2), so a genuinely extreme location doesn't flatten to the
   same score as a merely bad one.

`normalizeAnchors()` sorts these, collapses ties to their lowest percentile,
and drops any point that would make the curve non-monotonic.
`percentileFor(value, baseline)` interpolates linearly between the two
bracketing anchors; `bucketScore()` inverts it (`100 − percentile`, clamped).

### Aggregating buckets → one sub-score

`aggregate()` is a weighted mean of a tier's bucket scores
(`BUCKET_WEIGHTS` for complaint tiers, `AMENITY_WEIGHTS` for amenity tiers —
see [`backend-config-and-scripts.md`](./backend-config-and-scripts.md) for
why weight, not padding a bucket's type list, is the place to change its
influence).

### `scoreTier(tierName, counts, baseline)`

Zero-fills any missing bucket (defends against `NaN` poisoning the mean),
computes each bucket's score, the tier's aggregate `score` and `band`
(`bandFor()`), and **confidence**, checked in priority order:

<a name="confidence"></a>

| Condition | `confidence` | `confidenceReason` |
|---|---|---|
| No baseline available at all | `low` | `no_baseline` |
| Baseline sampled at different radii than currently configured | `low` | `stale_baseline_radius` |
| Every bucket in the tier is exactly zero | `low` | `no_complaints_found` |
| Every amenity bucket in the tier is past `AMENITY_MAX_METERS` | `low` | `none_within_range` |
| otherwise | `normal` | `null` |

The all-zero case matters in practice: a mid-street (not rooftop-precise)
coordinate returns zero building complaints, which without this flag would
present as a *perfect* building — a lookup failure disguised as good news.
`bucketConfidence` lists only non-normal buckets — today only
`streetCondition` (`LOW_CONFIDENCE_BUCKETS`), because ~25.6% of `Street
Condition` 311 records have no geocode and the null rate is non-uniform by
borough, so it doesn't cancel out against the baseline.

`buildReport(counts, baseline, meta)` assembles the final response for the
two complaint tiers; the amenity tiers go through the same `scoreTier()` core
but are assembled by `amenityService.js` into their own top-level sections.

---

## `explain.js` — deterministic + AI explanations

Every complaint sub-score always carries a **deterministic** template
explanation (`explainFromTemplate()`), computed inline from whatever counts
the response already has. The only text in the whole app that ever goes
through an AI model is the **whole-report summary** (`tier=overall`):
`explainOverallFromTemplate()` is the instant fallback,
`explainOverallWithAI()` is the real generation, and `services/explain.js`
wraps that call in try/catch — any failure (timeout, rate limit, provider
down) falls through to the template, so the AI feature can never show a
broken or empty state.

**Caching and the staleness fix.** The summary is generated once and cached
in its own document (not regenerated per request), stamped with `basedOn` —
the complaint-counts timestamp it was generated from. A cached summary is
only trusted when `basedOn` matches the *current* counts timestamp exactly;
otherwise it regenerates. This exists because the summary's own cache TTL is
independent of the counts documents it describes — without the stamp, a
counts refresh could silently outlive the cached summary that was written
about the old numbers.

`templateExplanation.js`, `templateAmenityExplanation.js`, and
`templateOverallSummary.js` hold the deterministic copy for, respectively,
one complaint tier, one amenity tier, and the whole-report summary — each a
"pick the dominant bucket and describe it" function with no network or
randomness, so it's directly unit-testable.

---

## `amenityService.js` — the four amenity tiers

- **`getAmenityMetrics(lat, lng)`** — transit/parks/bike. Pure in-memory
  nearest-neighbor lookup (`providers/amenities/spatialIndex.js`) against
  data loaded once at process start (`providers/amenities/index.js`). No
  network, no Mongo, no new caching layer. Optionally corrects the top
  candidates' straight-line distances to real walking distances via one
  batched Google Routes API call per request (see
  [`backend-providers.md`](./backend-providers.md#googleroutesjs--optional-walking-distance-correction)).
- **`getWalkabilityMetrics(lat, lng, { cacheOnly })`** — grocery/restaurant/
  cafe/school. The one amenity tier with an independent failure mode: a live,
  billed Google Places call on a cache miss, capped at
  `GOOGLE_PLACES_TIMEOUT_MS` (4s) and never made at all when `cacheOnly` is
  set (the homepage/showcase path).
- **`getNearbyAmenityInstances(tier, bucket, lat, lng, { limit })`** /
  **`getNearbyWalkabilityInstances(bucket, lat, lng)`** — back
  `GET /api/amenities/nearby`; see
  [`backend-routes.md`](./backend-routes.md#amenities--amenitiesjs) for the
  subway-complex/bus-pole clustering these apply.

---

## `showcaseService.js` — the homepage's real-data directory

- **`buildShowcase({ limit, mode })`** — reads the address directory
  (`providers/addressDirectory.js`), keeps only rows whose complaint-counts
  cache is still warm, and returns real cached score payloads with an
  address attached. Never calls Socrata — a cold cache just yields fewer
  items.
- **`showcaseFallback()`** — one curated address (`config/showcase.js`)
  picked at random, sent on every response so there's always something real
  to render even with an empty directory.
- **`warmShowcase({ onProgress })`** — the only showcase path that goes
  upstream: fetches and caches the 8 curated addresses from Socrata. Backs
  both `GET /api/warm` and the local `npm run warm:showcase` script.

---

## `mockData.js` — offline mode

Opt-in via `USE_MOCK_DATA=1`. Generates **counts only** and hands them to the
*real* `scoring.js#buildReport()` — mock and live diverge in exactly one
place (where the counts came from), so the mock can never drift out of shape
with the real response contract.

- Counts are **derived from the coordinate** (FNV-1a hash → seeded PRNG), not
  random — the same address always returns the same report.
- Skewed toward low counts (`rand() ** 2.5`) to mimic 311's real long-tailed
  distribution.
- Ships its own `MOCK_BASELINE` so mock mode needs zero files, zero Mongo,
  zero network.
