# Backend — Config & Scripts

## `src/config/constants.js` — single source of truth

Every tunable value in the backend lives here. Complaint-type strings,
status strings, and amenity bucket definitions must **never** be re-derived
elsewhere — always import from this file.

### Dataset & the twelve complaint buckets

| Constant | Value | Notes |
|---|---|---|
| `SOCRATA_DATASET_ID` | `erm2-nwe9` | NYC 311 Service Requests |
| `LOCATION_FIELD` | `"location"` | The geo-typed column `within_circle()` requires — `latitude`/`longitude` are plain numbers and get rejected |

| Tier | Bucket | 311 `complaint_type` values |
|---|---|---|
| **building** (25m) | `heatHotWater` | `HEAT/HOT WATER` |
| | `unsanitaryCondition` | `UNSANITARY CONDITION` |
| | `plumbing` | `PLUMBING` (HPD), `Plumbing` (DOB, minus its permit descriptor — see below), `WATER LEAK` |
| | `repairs` | `PAINT/PLASTER`, `DOOR/WINDOW`, `FLOORING/STAIRS`, `OUTSIDE BUILDING` |
| | `electricGas` | `ELECTRIC`, `APPLIANCE`, `GENERAL` |
| | `buildingSafety` | `SAFETY`, `Safety`, `ELEVATOR` (HPD), `Elevator` (DOB) |
| **block** (350m) | `noise` | `Noise - Residential`, `Noise - Street/Sidewalk`, `Noise - Vehicle`, `Noise - Commercial` |
| | `parking` | `Illegal Parking`, `Blocked Driveway`, `Abandoned Vehicle`, `Derelict Vehicles` |
| | `streetCondition` | `Street Condition`, `Sidewalk Condition`, `DEP Street Condition` |
| | `sanitation` | `Dirty Condition`, `Illegal Dumping`, `Missed Collection`, `Rodent`, `Graffiti`, `Litter Basket Complaint`, `Residential Disposal Complaint` |
| | `infrastructure` | `Street Light Condition`, `Traffic Signal Condition`, `Water System`, `Sewer`, `Damaged Tree` |
| | `publicSafety` | `Encampment`, `Homeless Person Assistance`, `Drug Activity`, `Panhandling`, `Drinking` |

`EXCLUDED_DESCRIPTORS` drops individual descriptors from a type that otherwise
counts: today only DOB `Plumbing`'s "Plumbing Work - Illegal/No Permit/
Standpipe/Sprinkler" (about 1,700 of its 6,800 rows in 24 months; unpermitted
work rather than a condition). `socrata.js#typeInClause()` applies it
NULL-safely in every query, and the baseline sampler and `verifyDataset.js`
import the same function, so scores, complaint lists and baselines all see the
same rows.

`TYPE_TO_BUCKET` is the flat reverse lookup `socrata.js` uses to sum every
string variant into one number per bucket. Deliberately excluded (see
`backend/CLAUDE.md` for the full reasoning): General Construction/Plumbing
(construction/permit work), Non-Residential Heat, Noise -
Helicopter/Park/House of Worship, DEP's generic Noise (mostly construction),
DOHMH indoor types (tiny, overlap HPD), and DEP Lead (test-kit requests).
Dirty Condition counts on the block (`sanitation`), never against a building.

Null-geocode rates for the types added 2026-09 (last quarter) are all well
below `streetCondition`'s: every building type is under 0.02%, and the worst
block types are Derelict Vehicles 9.9% (about 2% of `parking` overall) and
Traffic Signal/Street Light about 7% (`infrastructure` 3.7% overall). None
is flagged in `LOW_CONFIDENCE_BUCKETS`.

### Status buckets

Eight raw 311 `status` values collapse to three UI buckets via
`STATUS_TO_BUCKET`: `Closed`/`Cancel` → `closed`; `In Progress`/`Pending`/
`Assigned`/`Started` → `in-progress`; `Open`/`Unspecified` → `open`.
`Unspecified` deliberately lands on `open`, not `in-progress` — it carries no
evidence anyone acted, and claiming progress that can't be evidenced is the
worse error for someone deciding on a lease. Unknown future values default
the same way, via `statusBucket()`.

### Time window & scoring knobs

| Constant | Value | Meaning |
|---|---|---|
| `WINDOW_MONTHS` | 24 | Trailing window for all complaint counts |
| `BUCKET_WEIGHTS` | all `1` | Complaint-tier bucket weights. Change a bucket's influence here, never by padding its type list |
| `AMENITY_WEIGHTS` | subway ×2, grocery ×2, rest ×1 | Amenity-tier bucket weights — separate constant so it doesn't disturb `BUCKET_NAMES`-derived test assertions |
| `BAND_THRESHOLDS` | good ≥70, fair ≥40, else poor | Complaint-tier bands, inclusive lower bounds |
| `AMENITY_BAND_THRESHOLDS` | excellent ≥65, typical ≥35, else carDependent | Deliberately lower/differently worded — an amenity score is a citywide percentile, and NYC is transit-dense to begin with, so 50 is a fine outcome, not a middling one |
| `SCORE_ANCHOR_PERCENTILES` | median→50, p90→90 | Where the baseline's two real data points sit on the percentile curve |
| `SCORE_TAIL_MULTIPLIER` | 2 | Curve reaches 100 at `p90 + 2×(p90−median)` |
| `SCORE_DEGENERATE_SPAN` | 10 | For a bucket whose median *and* p90 are both 0, one unit is already unusual |
| `LOW_CONFIDENCE_BUCKETS` | `{ streetCondition }` | ~25.6% of `Street Condition` rows have no geocode, non-uniformly by borough |

### Socrata client & complaints endpoint

| Constant | Value | Notes |
|---|---|---|
| `SOCRATA_TIMEOUT_MS` | 25000 | Raised from an original 5s — a cold `within_circle` query was measured 0.4–33.1s with no stable correlation to row count or warmth; 25s × 3 attempts still fits Vercel's 300s cap (Fluid Compute) |
| `SOCRATA_MAX_RETRIES` | 2 | Only on 429/5xx |
| `SOCRATA_ROW_LIMIT` | 50000 | Socrata's own ceiling on `$limit` |
| `COMPLAINTS_DEFAULT_LIMIT` / `MAX_LIMIT` | 1000 / 5000 | Row cap for `/api/complaints` point queries |

### Grouped complaints & trend

| Constant | Value | Notes |
|---|---|---|
| `COMPLAINT_GROUPS_CACHE_LIMIT` | 10000 | Sized from measured densest address (Ludlow St, 2,929 grouped rows) with ~3.4x headroom |
| `COMPLAINT_FILL_TIMEOUT_MS` / `RETRIES` | 120000 / 1 | The grouped fill costs more than the raw fetch it replaces — measured 2.3–74.3s |
| `TREND_WINDOW_OPTIONS` | `[3,6,9,12,18,24]` | Closed set — each is its own cache key and upstream query |
| `TREND_DEFAULT_MONTHS` | 9 | Spans a full heating season plus a summer without dragging in a prior tenant's history; also the fastest window measured |

### Cache & baseline

| Constant | Value |
|---|---|
| `CACHE_COLLECTION` / `TREND_CACHE_COLLECTION` / `COMPLAINT_GROUPS_COLLECTION` | `complaint_cache` / `trend_cache` / `complaint_groups_cache` — separate collections because `writeCounts()`'s `replaceOne` would otherwise drop anything stored alongside it on a refresh |
| `ADDRESS_LOOKUPS_COLLECTION` | `address_lookups` — no TTL, unlike the three above (see [`backend-providers.md`](./backend-providers.md#addressdirectoryjs--the-address_lookups-collection)) |
| `CACHE_COORD_PRECISION` / `CACHE_TTL_SECONDS` | 4 decimals (~11m) / 24h |
| `BASELINE_SAMPLE_SIZE` / `SEED` | 250 / fixed. The seed alone never delivered the reproducibility it claims — the date slices `candidateCoords` draws from are derived from `Date.now()`, the candidate query is deliberately unordered, and the cache it was meant to hit expires in 24h. The drawn points are committed instead (`--resample` to redraw); see `scripts/lib/samplePoints.js` |
| `BASELINE_THINNING_GRID_DEGREES` / `MIN_BOROUGH_SHARE` | 0.003° (~330m) / 0.08 — spatial thinning plus a per-borough floor so Staten Island isn't drowned out |

### Showcase & rate limits

`SHOWCASE_MAX_LIMIT` / `DEFAULT_LIMIT`: 12 / 6. `ADDRESS_MAX_LENGTH`: 200.

Per-caller-per-minute ceilings, tiered by what a call **costs**, not by how
the request looks:

| Constant | Limit | Covers |
|---|---|---|
| `RATE_LIMIT_UPSTREAM` | 60/min | Anything that can reach Socrata on a miss: `/api/score`, `/api/trend`, `/api/complaints` default mode |
| `RATE_LIMIT_FILL` | 10/min | `/api/complaints?complete=1` cache **misses** only (the fill, measured 2.3–74.3s per cold address); cached pages pay only `RATE_LIMIT_UPSTREAM` |
| `RATE_LIMIT_AI` | 30/min | `/api/explanation` — spends a metered AI key |
| `RATE_LIMIT_INTERNAL` | 600/min | `POST /api/lookups` — secret-gated, every legitimate call is from one caller (our own frontend), so this is a circuit breaker, not per-visitor fairness |
| `RATE_LIMIT_READ` | 240/min | Cache-only reads: `/api/showcase`, in-memory amenity lookups |
| `RATE_LIMIT_MAX_KEYS` | 20,000 | Distinct caller keys held in memory before the whole table drops, so the limiter's own bookkeeping can't become the exhaustion it exists to prevent |

### AI explanation layer

| Constant | Value | Notes |
|---|---|---|
| `DEFAULT_AI_PROVIDER` | `ollama` | Local dev is the default environment |
| `AI_MODELS.ollama` / `.gemini` | `llama3.1:8b` / `gemini-3.5-flash-lite` | Env-overridable (`OLLAMA_MODEL`, `GEMINI_MODEL`). Model strings live only here so a deprecation is a one-line swap |
| `GEMINI_THINKING_BUDGET` | `null` (unset) | Model-dependent: `gemini-3.5-flash-lite` rejects `thinkingConfig` with 400; older `gemini-2.5-*` models need `thinkingBudget: 0` or thinking tokens can eat the whole output cap. Set via env when pointing at a 2.5 model |
| `AI_TEMPERATURE` | 0.3 | Consistency over creativity |
| `AI_MAX_OUTPUT_TOKENS` | 180 | Sized for the ~120-word summary target; Gemini counts thinking tokens against this too |
| `AI_TIMEOUT_MS` | ollama 45000, gemini 12000 | Ollama on CPU is genuinely slow; this call is on its own request budget by design, but still needs a ceiling |

### Amenity tiers

`AMENITY_TIERS` (transit/parks/bike/walkability, each 800m radius — the
standard ~10-minute walkshed) is deliberately **not** part of `RADIUS_TIERS`:
that constant is Socrata-coupled by derivation (`TYPE_TO_BUCKET` feeds the
SoQL `in (...)` clause), so mixing a static tier into it would risk injecting
e.g. `"subway"` into a live 311 query. Only `walkability` has no `dataset`
field — the loop in `amenityService.js` that finds a preloaded spatial index
keys off that field, so its absence skips walkability by construction rather
than needing an explicit exclusion list.

| Constant | Value | Notes |
|---|---|---|
| `AMENITY_MAX_METERS` | 2000 | Past this, "nearest" stops describing the address and starts describing the city |
| `AMENITY_GRID_DEGREES` | 0.005° (~450m) | Grid cell size for the in-memory nearest-neighbor index |
| `AMENITY_LANE_SPACING_METERS` | 40 | Bike-lane LineStrings are resampled to a point every this many metres (measured against the real dataset — 25m produced a 3.3MB file; 40m keeps accuracy within ±20m at a much smaller size) |
| `NON_DISCRETE_AMENITY_BUCKETS` | `["bikeLane", "protectedLane"]` | These are a resampled route line, not discrete places — `GET /api/amenities/nearby` excludes them outright rather than returning a meaningless point cloud |
| `BUS_STOP_CLUSTER_RADIUS_METERS` | 10 | Stops within this distance merge into one physical pole at build time |
| `AMENITY_SUBWAY_COMPLEX_CAP` / `AMENITY_BUS_STOP_CAP` | 5 / 5 | How many distinct complexes/poles `GET /api/amenities/nearby` returns, after clustering/dedup |
| `AMENITY_ROUTE_CANDIDATES` | 3 | Straight-line-nearest candidates per bucket sent to Google Routes for real walking-distance correction |
| `GOOGLE_ROUTES_TIMEOUT_MS` | 4000 | On the score request's critical path — must not make `/api/score` hang |

### Google Routes cost & pacing

`computeRouteMatrix` is billed per **element** (origins x destinations), not
per request, and capped at 3,000 elements/minute. The single batched call per
`/api/score` therefore costs `AMENITY_ROUTE_ELEMENTS_PER_CALL` = 27 billed
elements, not one — batching bounds latency, not spend.

| Constant | Value | Notes |
|---|---|---|
| `GOOGLE_ROUTES_ELEMENTS_PER_MINUTE` | 3000 | Google's published ceiling, in elements |
| `AMENITY_ROUTE_ELEMENTS_PER_CALL` | 27 | Derived: dataset-backed buckets x `AMENITY_ROUTE_CANDIDATES`. Walkability has no `dataset` and is never routed |
| `GOOGLE_ROUTES_QUOTA_UTILISATION` | 0.8 | Headroom. Pacing controls when a call *starts*, not when Google counts it, so jitter and retries land on top of the nominal rate |
| `AMENITY_BASELINE_ROUTE_PACING_MS` | 675 (derived) | `60000 / ((3000 x 0.8) / 27)`. Stays correct if the candidate count or bucket list changes |
| `AMENITY_DISTANCE_CACHE_COLLECTION` | `amenity_distance_cache` | Own collection so it can carry its own TTL — Mongo ties `expireAfterSeconds` to the collection's index |
| `AMENITY_DISTANCE_CACHE_TTL_SECONDS` | 180 days | Was silently 24h while these lived in `complaint_cache`, re-buying a years-stable answer nightly |

### HTTP cache headers (`src/lib/httpCache.js`)

Endpoints whose answer is a pure function of the URL carry a `Cache-Control`
so a repeat request costs no invocation. Three things deliberately do **not**:
`GET /api/showcase` (randomises its `fallback` per call and offers
`mode=random`), `GET /api/amenities/nearby?tier=walkability` (served
cache-only, so a cold empty list becomes populated), and `POST /api/score`
(a POST). Error responses never get a directive.

| Endpoint | `s-maxage` | `stale-while-revalidate` |
|---|---|---|
| `GET /api/amenities/nearby` (static tiers) | 7d | 30d |
| `GET /api/trend` | 1h | 1d |
| `GET /health` | `no-store` | — |

### Walkability (live Google Places tier)

| Constant | Value | Notes |
|---|---|---|
| `WALKABILITY_MAX_RESULTS` | 20 | One Nearby Search call requests all four bucket types at once |
| `WALKABILITY_CACHE_PRECISION` | 3 decimals (~111m) | Coarser than the 4dp complaint cache — maximizes hit rate on a **billed** call |
| `WALKABILITY_CACHE_TTL_SECONDS` | 30 days | Grocery stores/restaurants/schools change on a timescale of months, not days |
| `WALKABILITY_BASELINE_PER_BUCKET` | reasoned, not sampled | Order-of-magnitude judgements, not a live-sampled baseline — sampling would mean paying for 150 live Places calls up front, exactly the cost this tier's live-and-cached design avoids |
| `GOOGLE_PLACES_TIMEOUT_MS` | 4000 | Same critical-path reasoning as the Routes timeout |

### Input validation

`NYC_BOUNDS`: `lat 40.4–40.95`, `lng -74.3 to -73.7`. Anything outside is a
`400 out_of_bounds`.

---

## `scripts/` — offline tooling

Run with `npm run <script>` (each loads `.env` via Node's built-in
`--env-file-if-exists` flag).

| Script | `npm run` | What it does |
|---|---|---|
| `buildBaseline.js` | `baseline` | Computes the citywide complaint baseline `scoring.js` compares every count against — a borough-balanced, spatially-thinned sample of ~250 coordinates per tier, reused from the committed `src/config/baselineSamplePoints.json` unless `--resample` is passed. Counts are read cache-first; cached counts carry a `typeSignature` of the definitions they were built from, so a changed type list or excluded descriptor already reads as a miss. `--refresh` bypasses the cache entirely, for when you want fresh counts regardless. The frontend sync runs as the `postbaseline` npm hook rather than an `&&` chain, so `npm run baseline -- --dry-run` flags reach this script (a chain passed them to the sync script instead, and `--dry-run` was silently ignored) (building-tier samples come only from the building-tier types, which are HPD building-interior types plus DOB `Plumbing`/`Elevator`; block-tier samples come from every configured type, `ALL_COMPLAINT_TYPES`, since mixing them once dragged the building median to ~1). Widening the buckets therefore widens the pool a `--resample` draws from, for this script and `baseline:amenities` alike. A plain rerun reuses the committed points and is unaffected. Writes to Mongo **and** the committed `src/config/baseline.json`. |
| `buildAmenities.js` | `build:amenities` | Fetches and distills all six amenity buckets (subway, rail, bus, parks, bike share, bike lanes) from their real sources — see `backend/CLAUDE.md`'s "Amenity Scores" section for each source and its quirks (bus has no Socrata dataset; subway/rail are on `data.ny.gov`, not the city catalog). Writes committed JSON under `src/config/amenities/`. |
| `buildAmenityBaseline.js` | `baseline:amenities` | The amenity-tier equivalent of `buildBaseline.js` — samples ~150 coordinates (`AMENITY_BASELINE_SAMPLE_SIZE`) and computes median/p90 distance per bucket. Measures each point with the same live Google Routes walking-distance correction `/api/score` uses (with `GOOGLE_MAPS_API_KEY` set) — the baseline has to reflect the same distance definition scoring compares against it. Sample coordinates come from the committed `src/config/amenityBaselineSamplePoints.json` unless `--resample` is passed (a resample draws from `ALL_COMPLAINT_TYPES`). Points already in `amenity_distance_cache` (180-day TTL) issue no Routes call, so a rerun within that window is free. Calls are *started* `AMENITY_BASELINE_ROUTE_PACING_MS` apart (derived from Google's 3,000-elements/minute ceiling and `AMENITY_ROUTE_ELEMENTS_PER_CALL`, not guessed) rather than sleeping between completed ones, so response latency overlaps and ~150 points take ~100s instead of 4-8 minutes at an identical element rate. `AMENITY_BASELINE_ROUTE_RETRIES` absorbs transient 429/5xx, and the run **refuses to write** if any point still degraded to straight-line — those distances are systematically short and would bias the baseline. Walkability is excluded (no free dataset to sample against; see its reasoned-constants note above). |
| `baselineDiff.js` | — | `node scripts/baselineDiff.js <old.json> <new.json>`: a markdown table of each bucket's median/p90 change between two baselines, flagging any move over 25% (more often an upstream data problem than a real change). Writes the description of the monthly baseline PR (`.github/workflows/monthly-baseline.yml`: 07:00 UTC on the 2nd, rebuilds with `--refresh` and no Mongo, runs the tests, then opens or updates the `automation/monthly-baseline` PR). |
| `verifyDataset.js` | `verify:dataset` | One-off checks against the live 311 Socrata dataset: identity/title, geo column name, null-geocoding rate per type and per bucket, any configured type with zero rows in the window, and how many rows each `EXCLUDED_DESCRIPTORS` entry removes (flagging one that matches nothing, e.g. after DOB renames it). Rerun any time NYC changes the dataset shape, and after editing a bucket's type list. |
| `verifyAmenities.js` | `verify:amenities` | The amenity-dataset equivalent — re-fetches each source and compares row counts/shape against what's committed, to catch a source moving or thinning out silently. |
| `verifyCache.js` | `verify:cache` | Exercises the Mongo cache read/write path against a real (or in-memory) Mongo instance, outside the test suite. |
| `verifyScoring.js` | `verify:scoring` | Sanity-checks the scoring curve's behavior (monotonicity, percentile placement, band spread) against real or synthetic distributions. |
| `verifyExplanations.js` | `verify:explanations` | Runs both AI adapters against identical inputs so their tone/length can be eyeballed side by side before a demo. |
| `warmShowcase.js` | `warm:showcase` | Calls `showcaseService.js#warmShowcase()` directly (no HTTP, no secret) — the same work `GET /api/warm` does, for local use. |
