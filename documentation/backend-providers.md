# Backend — Providers (`backend/src/providers/`)

The only layer allowed to talk to the outside world: NYC's Socrata Open Data
API, MongoDB, and the committed baseline file. Services never bypass this
layer to call `fetch()` or the Mongo driver directly.

---

## `socrata.js` — the 311 data client

### `query(params, { retries, timeoutMs })`

The low-level primitive everything else builds on: one `GET` against
`SOCRATA_ENDPOINT` with an `X-App-Token` header (if `SOCRATA_APP_TOKEN` is
set — the API still works without one, just throttles harder).

- **Bounded retry with jittered backoff** on `429` and `5xx` only —
  `300ms × 3^attempt × (0.5–1.0 jitter)`, up to `SOCRATA_MAX_RETRIES` (2)
  retries. A `4xx` other than 429 is *not* retried — a malformed SoQL query
  fails identically every time, so retrying just delays the eventual error.
- Hard timeout via `AbortSignal.timeout(timeoutMs)`, default 5s
  (`SOCRATA_TIMEOUT_MS`) — overridable for the offline scripts, whose
  citywide aggregate queries are far slower than the request-path budget.
- Throws `SocrataError` (carries `.status`) after exhausting retries; routes
  translate this into a `503`.

### `fetchCountsForTier(lat, lng, tierName, { now })`

One HTTP call, grouped by `complaint_type` **and** `status`:

```
$select = complaint_type, status, count(*) AS count
$where  = within_circle(location, lat, lng, radiusMeters)
            AND complaint_type in (...)
            AND created_date > '<24-month cutoff>'
$group  = complaint_type, status
$limit  = 50000
```

Zero-fills every bucket *before* summing rows in — a bucket with zero
complaints returns no row at all from Socrata, and a missing key would
otherwise become `NaN` downstream. Each returned row's `complaint_type` is
mapped to its bucket via `TYPE_TO_BUCKET` and **summed** into that bucket
(never scored per-string — buckets have different numbers of type variants,
so per-string averaging would silently underweight noise against plumbing).
`status` rides along in the same query (not a second call) to also produce
`bucketStatusCounts` — one query, two aggregates, still two calls per
uncached address, not three.

### `fetchAllCounts(lat, lng, options)`

Both tiers for one point, issued **in parallel** — the two HTTP calls per
uncached address the project budgets for (not six, not twelve).

### `fetchComplaints(lat, lng, radiusMeters, { now, limit })`

Individual rows (not aggregated) for the `/api/complaints` heatmap endpoint.
Ordered `created_date DESC`, capped at `limit`. This is why that endpoint
must never be used for counting — Socrata returns the most *recent* N rows,
so a dense block silently loses its older months once it hits the cap.

### Grouped complaints (`complete=1`) and trend

Two more query shapes live here for the same client: one groups by
`(day, complaint_type, status)` via `date_trunc_ymd` for the complaints
browser (backs `complaint_groups_cache`), and one groups by
`(month, complaint_type)` via `date_trunc_ym` for `GET /api/trend` (backs
`trend_cache`). Both exist because raw-row paging cannot answer either
question honestly on a dense block — see
[`backend-routes.md`](./backend-routes.md#get-apicomplaints--complaintsjs)
for the measured collapse ratios.

---

## `cache.js` — the Mongo count cache (`complaint_cache` collection)

Two rules shape every function in this file:

1. **The cache is an optimization, never a dependency.** Every function
   degrades to "miss" (or a no-op write) if Mongo is unconfigured,
   unreachable, or slow. A cache outage must never turn into a `500` on the
   score endpoint mid-demo.
2. **No 2dsphere index.** Spatial filtering is Socrata's job; the cache
   lookup is an exact match on a *rounded* coordinate, not a geo query.

### Key functions

- `roundCoord(value)` — rounds to `CACHE_COORD_PRECISION` (4 decimal places,
  ~11m). Uses `Number(v.toFixed(n))` rather than `Math.round(v * 1e4) / 1e4`,
  because the latter leaves floating-point dust that would never match a
  stored key on a later lookup.
- `readCounts(lat, lng, radiusTiers)` — one query for however many tiers are
  requested. Rejects a document whose `counts` object is missing a bucket
  (`isCompleteCounts`) — treats a partially-written document (interrupted
  write, schema drift) as a miss rather than feeding a bucket-shaped hole
  into the scoring mean.
- `writeCounts(lat, lng, radiusTier, counts, { now })` — upserts, refreshing
  `createdAt` on every write. That refresh is what turns the TTL index into a
  **sliding** 24h window instead of a hard expiry from first insert.
- `ensureCacheIndexes()` — creates the compound `{lat, lng, radiusTier}`
  unique index (so a race between two concurrent cache misses can't leave two
  documents describing the same circle) and the `createdAt` TTL index.
  Memoized so it only runs once per process.

---

## `mongo.js` — connection management

Deliberately the *only* file with Mongo connection logic (no collection
queries live here — that's `cache.js` and `baseline.js`).

**Dev and prod point at different databases; the code does not know which.**
Dev is a local mongod in Docker (`mongodb://127.0.0.1:27017`, database
`nyc-streetwise-dev`); prod is Atlas (`mongodb+srv://…`, database
`nyc-streetwise`). Nothing in this file — or anywhere else — branches on
environment. Only `MONGODB_URI` and `MONGODB_DB` change.

- `isMongoConfigured()` → true when `MONGODB_URI` is set **and usable**.
- `getDb()` connects lazily and memoizes the connection promise. Returns
  `null` immediately if no URI is set — nothing here throws on a missing
  credential.
- A **failed** connection clears the memo, so the *next* request retries
  instead of being permanently stuck with a rejected promise for the process
  lifetime.
- Fails fast: `serverSelectionTimeoutMS` / `connectTimeoutMS` default to 8s
  (overridable via `MONGO_SERVER_SELECTION_TIMEOUT_MS`), so a hung driver
  can't sit on a request well past the point a user has given up on the page.
  8s rather than 5s because a cold Atlas M0 cluster can be slow to elect a
  primary, and a spurious timeout there costs a cache miss on every request.
- `closeMongo()` — used by tests and graceful shutdown.

### Three things exist specifically because prod is Atlas

- **The `<db_password>` guard.** Atlas hands you the connection string with a
  literal `<db_password>` still in it. Pasted unedited, the driver throws a
  *parse* error — on every request, in a code path whose entire contract is that
  it degrades quietly. `isMongoConfigured()` detects the placeholder, warns
  once, and reports unconfigured, so a forgotten password costs you the cache
  instead of the deploy. It keys on the placeholder token, not on the presence
  of `<`/`>`, so a genuine (percent-encoded) password containing brackets is
  not misread.
- **The client is cached on `globalThis`,** not in module scope. Under
  `node --watch` and under serverless invocation reuse, the module registry can
  be rebuilt while the process lives on; a module-local memo is lost in that
  rebuild and the reimported copy opens a *second* pool. Do that enough times
  and you hit Atlas's per-cluster connection cap (500 on M0). `backend/CLAUDE.md`
  calls this out as a deployment requirement; this is where it is satisfied.
- **A bounded pool** — `maxPoolSize` 10 (`MONGO_MAX_POOL_SIZE`), `minPoolSize`
  0, `maxIdleTimeMS` 60s. The workload is read-mostly with a tiny working set,
  so a small pool is plenty and leaves the cluster's connection budget for
  everything else sharing it.

`test/mongo.test.js` covers all three against an in-memory mongod — no live
cluster, no password, so it actually runs in CI. The `mongodb://` vs
`mongodb+srv://` difference is invisible above this file: the driver resolves
SRV to the same wire protocol and no code inspects the scheme.

---

## `baseline.js` — the citywide comparison baseline

Loads the one document `scoring.js` compares every count against
(`{ median, p90, zeroShare }` per bucket — see
[`backend-services.md`](./backend-services.md#scoringjs--the-scoring-algorithm-pure-function)
for how those three numbers become a percentile curve).

### Two sources, in priority order

1. **Mongo** (`baseline` collection, `_id: "v1"`) — read first so the
   baseline can be refreshed (by rerunning `scripts/buildBaseline.js`)
   without a redeploy.
2. **The committed file**, `backend/src/config/baseline.json` — falls back to
   this when Mongo has nothing (or isn't configured at all). This is why a
   fresh clone with zero credentials still produces *real* scores, not just
   `no_baseline` for everyone.

### `isValidBaseline(doc)`

A baseline missing even one bucket would score that bucket against
`undefined` and silently hand out a free 100. The loader **rejects the whole
document** rather than partially trusting it — falling back to the committed
copy (or to `confidenceReason: "no_baseline"`) is the honest failure mode; a
half-baseline is not.

### `loadBaseline({ forceRefresh })`

Memoized for the process lifetime (re-reading per request would be a Mongo
round trip for a value that only changes when the baseline script reruns).
Returns `null` if nothing valid exists anywhere — the scorer surfaces that as
low confidence, not a crash.

### `saveBaseline(doc)`

Used only by `scripts/buildBaseline.js` — the request path never writes here.
Returns `false` (rather than throwing) if Mongo is absent or the write fails,
since the script always writes the committed JSON copy regardless.

---

## `amenityBaseline.js` — the amenity-tier comparison baseline

Same two-source, Mongo-then-committed-file pattern as `baseline.js` above,
for the `amenity_baseline` collection / `src/config/amenityBaseline.json`.
`isValidAmenityBaseline()` deliberately excludes walkability's four buckets
from its completeness check — that tier has no `dataset` field and is never
sampled into this file (see the "Amenity Scores" section of `backend/CLAUDE.md`),
so judging the committed file "incomplete" for lacking them would be wrong.

---

## `providers/amenities/` — the static amenity datasets

### `index.js` — Mongo-then-file loader

Mirrors `baseline.js`'s two-source pattern once more: `loadAmenities()` tries
the `amenity_datasets` Mongo collection first (so a monthly refresh doesn't
need a redeploy), falls back to the committed JSON files in
`src/config/amenities/` (`transit.json`, `parks.json`, `bike.json`) when
Mongo has nothing. `isValidDataset()` rejects a malformed or truncated
document the same way `isValidBaseline()` does — a partial dataset is a
worse failure mode than none. Loaded **once at process start**, not per
request — every amenity lookup on the request path reads this in-memory
structure, never Socrata or Mongo directly.

### `spatialIndex.js` — the nearest-neighbor grid

`buildIndex()` buckets every point into a coarse degree-sized grid
(`AMENITY_GRID_DEGREES`) and exposes `nearestN`, `allWithin`, and
`countWithin` over it — a cheap approximation that avoids both a real
spatial database and an O(n) scan per request. Subway/bus points carry two
additional interned side-arrays (`routeSets`/`routeIdx` for line info,
`complexIds`/`complexIdIdx` for MTA's station-complex grouping) built the
same way, so `GET /api/amenities/nearby` can group and dedupe without a
second lookup structure.

### `bikeShare.js` — Citi Bike GBFS + shared point encoding

Fetches Citi Bike's live `station_information.json` (used only by the
monthly refresh, `GET /api/refresh-amenities` — the one bucket that changes
fast enough to be worth re-fetching). Also owns `encodeBucket()`, the shared
point-array format (`pts`/`names` plus the optional `routeSets`/`complexIds`
side-arrays) every amenity bucket is committed in, so `spatialIndex.js` has
one shape to build an index over regardless of source.

---

## `googleRoutes.js` — optional walking-distance correction

`computeWalkingDistances(origin, destinations)` calls Google's Routes API
`computeRouteMatrix` in **one batched request** covering every amenity
bucket's top `AMENITY_ROUTE_CANDIDATES` (3) straight-line candidates across
all three static tiers — not one call per candidate, which is what keeps
this to one extra network call per `/api/score`, the same order of magnitude
as the Socrata call already on that path. Requires `GOOGLE_MAPS_API_KEY`;
without it (or on any failure — timeout, non-2xx, malformed body) every
distance simply stays straight-line, never a 500. Corrected distances are
cached per rounded coordinate in `CACHE_COLLECTION`
(`AMENITY_DISTANCE_CACHE_RADIUS_TIER`) — a completely empty correction
(Google down, no key) is deliberately **not** cached, since that's a
transient failure, not a fact about the address.

## `googlePlaces.js` — walkability's live lookup

`searchNearbyPlaces(origin, radiusMeters, includedTypes)` sends all four
walkability buckets' Google place types in a **single** `searchNearby`
request (Places API, New), ranked by distance; `amenityService.js` sorts the
up-to-20 results back into buckets by inspecting each place's own `types`.
One billed call per (new) coordinate, not four. Requires `GOOGLE_MAPS_API_KEY`
with Places API (New) enabled; degrades to `[]` on any failure, same
never-throws contract as `computeWalkingDistances` above. Results are cached
in their own `walkability_cache` collection with a 30-day TTL and coarser
(~111m) coordinate rounding than the other caches — see `backend/CLAUDE.md`'s
"Walkability Score" section for why this tier gets its own cache shape.

---

## `addressDirectory.js` — the `address_lookups` collection

The mapping from a cached coordinate to the address text a person actually
searched, and a lookup counter — backs `GET /api/showcase`. Written by
`POST /api/lookups`; `recordLookup()`'s address field is `$setOnInsert`, so a
coordinate keeps the **first** name given to it (avoids the homepage label
flickering between "456 Park Ave" and "456 Park Avenue" for the same
building). No caller identity, no session, no IP — a row says an address was
looked up, never who looked it up. Unlike the three caches above, this
collection has **no TTL index** — it holds the mapping needed to name a
coordinate at all, not a copy of city data that should expire.

---

## `providers/ai/` — the explanation model adapters

`index.js#getAdapter()` reads `AI_PROVIDER` and returns either `ollama.js`
(local dev, calls `http://localhost:11434/api/generate`) or `gemini.js`
(works anywhere, including serverless). Both implement the same
`generateExplanation({ sections }) -> Promise<string>` contract, built from
`prompt.js#buildOverallSummaryPrompt()` — the one prompt either adapter
sends. An unknown `AI_PROVIDER` throws rather than silently disabling the
feature, so a typo'd env var is loud, not a silent degrade. See
[`backend-services.md`](./backend-services.md#explainjs--deterministic--ai-explanations)
for how the caller handles a failure from either adapter.
