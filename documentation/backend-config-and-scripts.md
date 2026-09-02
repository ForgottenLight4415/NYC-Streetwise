# Backend — Config & Scripts

## `src/config/constants.js` — single source of truth

Every tunable value in the backend lives here. Complaint-type strings,
status strings, and amenity bucket definitions must **never** be re-derived
elsewhere — always import from this file.

### Dataset & the six complaint buckets

| Constant | Value | Notes |
|---|---|---|
| `SOCRATA_DATASET_ID` | `erm2-nwe9` | NYC 311 Service Requests |
| `LOCATION_FIELD` | `"location"` | The geo-typed column `within_circle()` requires — `latitude`/`longitude` are plain numbers and get rejected |

| Tier | Bucket | 311 `complaint_type` values |
|---|---|---|
| **building** (25m) | `heatHotWater` | `HEAT/HOT WATER`, `Heat/Hot Water` |
| | `unsanitaryCondition` | `UNSANITARY CONDITION`, `Unsanitary Condition` |
| | `plumbing` | `PLUMBING`, `Plumbing` |
| **block** (350m) | `noise` | `Noise - Residential`, `Noise - Street/Sidewalk`, `Noise - Vehicle`, `Noise - Commercial` |
| | `parking` | `Illegal Parking`, `Blocked Driveway` |
| | `streetCondition` | `Street Condition`, `Sidewalk Condition`, `DEP Street Condition` |

`TYPE_TO_BUCKET` is the flat reverse lookup `socrata.js` uses to sum every
string variant into one number per bucket. Deliberately excluded (see
`backend/CLAUDE.md` for the full reasoning): Dirty Condition (DSNY street
sanitation, not a landlord issue), General Construction/Plumbing (ambiguous),
Non-Residential Heat, and Noise - Helicopter/Park/House of Worship.

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
| `BASELINE_SAMPLE_SIZE` / `SEED` | 250 / fixed, so a rerun samples the same points and hits cache |
| `BASELINE_THINNING_GRID_DEGREES` / `MIN_BOROUGH_SHARE` | 0.003° (~330m) / 0.08 — spatial thinning plus a per-borough floor so Staten Island isn't drowned out |

### Showcase & rate limits

`SHOWCASE_MAX_LIMIT` / `DEFAULT_LIMIT`: 12 / 6. `ADDRESS_MAX_LENGTH`: 200.

Per-caller-per-minute ceilings, tiered by what a call **costs**, not by how
the request looks:

| Constant | Limit | Covers |
|---|---|---|
| `RATE_LIMIT_UPSTREAM` | 60/min | Anything that can reach Socrata on a miss: `/api/score`, `/api/trend`, `/api/complaints` default mode |
| `RATE_LIMIT_FILL` | 10/min | `/api/complaints?complete=1` — measured 2.3–74.3s per cold address |
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
| `buildBaseline.js` | `baseline` | Computes the citywide complaint baseline `scoring.js` compares every count against — a deterministic, borough-balanced, spatially-thinned sample of ~250 coordinates per tier (building-tier samples come only from HPD building-interior types; block-tier from all types, since mixing them once dragged the building median to ~1). Writes to Mongo **and** the committed `src/config/baseline.json`. |
| `buildAmenities.js` | `build:amenities` | Fetches and distills all six amenity buckets (subway, rail, bus, parks, bike share, bike lanes) from their real sources — see `backend/CLAUDE.md`'s "Amenity Scores" section for each source and its quirks (bus has no Socrata dataset; subway/rail are on `data.ny.gov`, not the city catalog). Writes committed JSON under `src/config/amenities/`. |
| `buildAmenityBaseline.js` | `baseline:amenities` | The amenity-tier equivalent of `buildBaseline.js` — samples ~150 coordinates (`AMENITY_BASELINE_SAMPLE_SIZE`) and computes median/p90 distance per bucket. Walkability is excluded (no free dataset to sample against; see its reasoned-constants note above). |
| `verifyDataset.js` | `verify:dataset` | One-off checks against the live 311 Socrata dataset: identity/title, geo column name, null-geocoding rate per bucket. Rerun any time NYC changes the dataset shape. |
| `verifyAmenities.js` | `verify:amenities` | The amenity-dataset equivalent — re-fetches each source and compares row counts/shape against what's committed, to catch a source moving or thinning out silently. |
| `verifyCache.js` | `verify:cache` | Exercises the Mongo cache read/write path against a real (or in-memory) Mongo instance, outside the test suite. |
| `verifyScoring.js` | `verify:scoring` | Sanity-checks the scoring curve's behavior (monotonicity, percentile placement, band spread) against real or synthetic distributions. |
| `verifyExplanations.js` | `verify:explanations` | Runs both AI adapters against identical inputs so their tone/length can be eyeballed side by side before a demo. |
| `warmShowcase.js` | `warm:showcase` | Calls `showcaseService.js#warmShowcase()` directly (no HTTP, no secret) — the same work `GET /api/warm` does, for local use. |
