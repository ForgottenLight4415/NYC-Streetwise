# CLAUDE.md — backend

## What this is

Express API for **Streetwise**, an NYC address-risk tool. Given a
coordinate, it returns a livability report: two complaint-based scores
(**Building Health**, **Block Quality**) from NYC 311 data, up to four
amenity-based scores (**Transit / Parks / Bike / Walkability Access**) from
static datasets plus a live Google Places lookup, and a plain-English
summary. This file covers the backend/data layer only — the frontend lives
in `../frontend`.

**For anything beyond "what and why," read the module docs first — this file
is deliberately short:**

- [`../documentation/backend-architecture.md`](../documentation/backend-architecture.md) — layering, request lifecycle
- [`../documentation/backend-routes.md`](../documentation/backend-routes.md) — every endpoint, request/response shapes
- [`../documentation/backend-services.md`](../documentation/backend-services.md) — orchestration + the scoring algorithm
- [`../documentation/backend-providers.md`](../documentation/backend-providers.md) — Socrata, Mongo, amenity datasets, Google/AI adapters
- [`../documentation/backend-config-and-scripts.md`](../documentation/backend-config-and-scripts.md) — every tunable constant, offline scripts
- [`README.md`](README.md) — setup: Docker, every env var, Ollama/Gemini

## Architecture

Three layers, kept separate for testability:

```
routes (Express) -> services (scoring + orchestration) -> providers (Socrata, Mongo, Google, AI)
```

Routes never call Socrata/Mongo/Google directly. `services/scoring.js` is a
**pure function** — no network, no clock — tested against fixtures. Never
geocodes: the frontend sends `{lat, lng}` from Google Places Autocomplete.

## Data source & the twelve complaint buckets

Dataset: NYC 311 Service Requests, Socrata UID `erm2-nwe9`. Two radius tiers,
six buckets each — **Building Health** (~25m: heat/hot water, unsanitary
condition, plumbing & leaks, repairs, electric & gas, building safety) and
**Block Quality** (~350m: noise, parking & vehicles, street condition,
sanitation, infrastructure, public safety). Full string lists live in
`src/config/constants.js` (`TYPE_TO_BUCKET`) — **never re-derive them
elsewhere.**

Non-obvious inclusion/exclusion decisions (do not silently change without
updating this file):

1. **Dirty Condition is a block type, never a building one** — it is DSNY
   street/curb sanitation, distinct from HPD's building-interior Unsanitary
   Condition. It counts in block `sanitation`, and must not be added to
   `unsanitaryCondition`.
2. **General Construction/Plumbing excluded** — an ambiguous DOB combined
   category, mostly construction-site and permit work, not the unit's
   condition. Title-case `Plumbing` is **DOB's** type, not an HPD case
   variant, and it counts in `plumbing` **by descriptor**:
   `EXCLUDED_DESCRIPTORS` drops "Plumbing Work - Illegal/No Permit/
   Standpipe/Sprinkler" (about 25% of it: unpermitted work, not a condition)
   and keeps defective/leaking plumbing, improper drainage (LL103/89), gas
   hook-up/piping, and inadequate sprinklers. Drainage is kept deliberately:
   it is a real condition of the property, even if often outside the unit.
   Sprinklers stay in `plumbing` rather than moving to `buildingSafety`
   (about 300 complaints in 24 months, and they are plumbing-code systems;
   moving them would need a synthetic complaint type in every list query).
   The exclusion lives in `socrata.js#typeInClause()`, which every query and
   the baseline sampler share, so scores, complaint lists and baselines agree.
3. **Non-Residential Heat excluded** — commercial, not relevant to a
   residential livability score.
4. **Noise scoped to 4 of 9 raw NYPD types** (Residential, Street/Sidewalk,
   Vehicle, Commercial) — Helicopter/Park/House of Worship are excluded as
   unrepresentative of daily block-level noise. DEP's generic `Noise` is also
   excluded: ~60% of it is construction (checked 2026-09), a different agency
   with a different reporting population, and folding it in would inflate
   `noise` near job sites. It could be revisited with a score-impact check.
5. **`parking` holds Illegal Parking, Blocked Driveway, Abandoned Vehicle and
   Derelict Vehicles** — all the same curb-space problem. Blocked Driveway
   alone is 1M+ records, so it materially changes the bucket if omitted.
6. **Buckets are weighted equally, never by padding a type list.** Related
   types fold into one bucket (Sidewalk Condition into `streetCondition`,
   WATER LEAK into `plumbing`, since it is the same HPD water-system repair
   domain) rather than becoming a thin bucket of their own. If a bucket ever
   needs a different weight, set it in `BUCKET_WEIGHTS`.
7. **Building buckets beyond the original three** use the rest of HPD's
   housing-code types: `repairs` (PAINT/PLASTER, DOOR/WINDOW,
   FLOORING/STAIRS, OUTSIDE BUILDING), `electricGas` (ELECTRIC, APPLIANCE,
   GENERAL — GENERAL's top descriptor is cooking gas), `buildingSafety`
   (SAFETY — smoke/CO detectors, fire escapes, window guards — plus HPD
   `ELEVATOR` and DOB `Elevator`). Pests and mold are already counted: they
   are descriptors under UNSANITARY CONDITION.
8. **`publicSafety` is a deliberate, contestable inclusion** — Encampment,
   Homeless Person Assistance, Drug Activity, Panhandling, Drinking. These
   counts reflect where unhoused people are and how heavily an area is
   policed and reported, not only physical conditions. They were included on
   purpose as something a prospective renter asks about. They stay in their
   own bucket so they can be reweighted or removed without touching the
   others. Illegal Fireworks (seasonal), Urinating in Public and
   Non-Emergency Police Matter (too vague) are excluded.
9. **Other excluded types.** DOHMH indoor types (Indoor Air Quality, Mold,
   Asbestos, Indoor Sewage) are tiny and overlap HPD's MOLD/SEWAGE
   descriptors, so at 25m they would almost always be zero. DEP `Lead` is
   100% "Lead Kit" (requests for a water-test kit, not hazard reports).
   Overgrown/Dead tree, Curb Condition, Street Sweeping, Standing Water and Air
   Quality are small or ambiguous and remain candidates.

**Critical weighting rule:** `getCounts` sums all string variants within a
bucket into ONE number before scoring. Never percentile a bucket's raw
strings individually and average — buckets have different variant counts
(noise has 4, plumbing has 3), and per-string averaging silently underweights
noise vs. plumbing.

**Status buckets** (eight raw 311 `status` values → three UI buckets) are
similarly centralized in `STATUS_TO_BUCKET` — see
[`backend-config-and-scripts.md`](../documentation/backend-config-and-scripts.md#status-buckets).
`Unspecified` maps to `open`, not `in-progress`, deliberately: it carries no
evidence anyone acted, and overclaiming progress is the worse error for
someone deciding on a lease.

## Scoring

`score(counts, baseline)` is a pure function: convert each bucket's raw count
(or, for amenity buckets, distance in meters) to a citywide percentile via a
piecewise curve anchored at `[0,0]`, `[median,50]`, `[p90,90]`, with a
zero-tie ceiling and an extrapolated tail; average the tier's bucket
percentiles into one sub-score; map to a band. Full algorithm in
[`backend-services.md`](../documentation/backend-services.md).

The baseline is computed by `scripts/buildBaseline.js` (a deterministic,
spatially-thinned, borough-balanced sample of ~250 coordinates per tier) and
committed to `src/config/baseline.json`, with a live copy in Mongo that wins
when present. Production has never had a Mongo copy: it scores against the
committed file. It is refreshed monthly by
`.github/workflows/monthly-baseline.yml`, which rebuilds on the committed
sample points and opens a PR with the new file, the regenerated frontend copy,
and a median/p90 diff table (`scripts/baselineDiff.js`); merging it is the
deploy. This baseline —
not a raw count — is what makes the score defensible. Do not skip rebuilding
it after changing `RADIUS_TIERS`, `WINDOW_MONTHS` or any bucket's type list;
the scorer catches a radius change (`stale_baseline_radius`) but not a window
or type-list change. Adding a bucket is self-protecting: a baseline (Mongo or
committed) missing any bucket is rejected whole, so an old Mongo copy is
ignored in favour of the committed file until the rebuilt one reaches Mongo.
After a type-list or descriptor change, run `npm run verify:dataset` (every
string and every excluded descriptor must have rows in the window) and
`npm run baseline` (which also regenerates the frontend's
`citywide-baseline.ts`). Pass `-- --refresh` whenever the change removes rows
without adding a bucket: the baseline reads counts cache-first, and a cached
document with every bucket present looks complete even though it holds the
old rows. Production's complaint cache self-heals the same way within its
24h TTL.

## API contract

The `POST /api/score` response shape is **append-only** — every field ever
added to it (amenity sections, `summary`, `bucketStatusCounts`, per-bucket
`routes`, ...) has been additive, and existing fields never change name,
type, or meaning without updating this file and
[`backend-routes.md`](../documentation/backend-routes.md) first. The full,
current, endpoint-by-endpoint contract with request/response shapes lives in
**[`backend-routes.md`](../documentation/backend-routes.md)** — that is the
canonical reference; don't let a second copy of it drift here.

**Two things worth calling out because they're easy to get backwards:**

- **`GET /api/explanation` only accepts `tier=overall`.** Building/block/
  transit/parks/bike/walkability each carry a deterministic "Why this score?"
  directly on `/api/score` — only the whole-report `summary` goes through an
  AI model, on its own slow-path request, so the AI latency never sits on
  `/api/score`.
- **`bucketStatusCounts` and `routes` are optional per-response** — absent on
  a cache document written before they shipped (self-heals within the 24h
  TTL) or on a hand-built payload that doesn't pass them. A caller must
  render its plain-count fallback rather than inventing or zero-filling one.

## Amenity scores (transit / parks / bike)

Distance-to-nearest, not complaint count, through the *same* `bucketScore()`
curve — distance is already lower-is-better. Sourced from small, static,
slow-changing public datasets (`scripts/buildAmenities.js`, committed under
`src/config/amenities/`), loaded once at process start, scored via an
in-memory grid index (`providers/amenities/spatialIndex.js`) — no Socrata, no
Mongo, no network on the request path. Deliberately **not** part of
`RADIUS_TIERS`/`BUCKET_NAMES` — those are Socrata- and baseline-coupled by
derivation, so a static tier mixed in would risk injecting a bucket name into
a live 311 query or instantly invalidating the committed complaint baseline.

**Subway is grouped by MTA's own `complex_id`** (e.g. Herald Sq's 6th Ave and
Broadway entrances are one complex), with a 1km outlier guard: a small number
of entrances (11 of 2,120, confirmed live) carry a `complex_id` whose *other*
entrances are 1km+ away — real mislabeling in MTA's own data. Trusting it
blindly merges the wrong station's name/routes together in both directions.
An outlier entrance keeps its own row's name/routes and becomes its own
single-entrance group. **Bus stops within 10m cluster into one physical
pole**, unioning routes — GTFS gives each route its own stop record even when
several board from the same curb. Both are capped and deduped in
`GET /api/amenities/nearby`; see
[`backend-routes.md`](../documentation/backend-routes.md#amenities--amenitiesjs)
for the exact behavior.

Optional walking-distance correction via one **batched** Google Routes API
call per `/api/score` (top 3 straight-line candidates per bucket, whichever
comes back real-shortest wins) — without `GOOGLE_MAPS_API_KEY`, every
distance just stays straight-line; nothing fails.

**That call is billed per ELEMENT (origins x destinations), not per request.**
Batching bounds latency to one round trip; it does not bound cost, which is
9 buckets x `AMENITY_ROUTE_CANDIDATES` = **27 elements per uncached score**.
So the corrections get their own `amenity_distance_cache` collection with a
180-day TTL: they used to sit in `complaint_cache` under a pseudo-tier and
silently inherit its 24h expiry, which re-bought a years-stable answer nightly.
Google's ceiling is 3,000 elements/minute, which is also what
`AMENITY_BASELINE_ROUTE_PACING_MS` is now derived from rather than guessed.

## Walkability score

The odd one out: no free public dataset exists for "groceries/restaurants/
cafes/schools near here," so this tier calls Google Places **live, per
report, cached per coordinate** (30-day TTL, coarser ~111m rounding than the
other caches — maximizing hit rate matters more on a billed call). Has **no**
`dataset` field in `AMENITY_TIERS`, which is what makes the generic amenity
loop skip it by construction; it's scored by its own function,
`getWalkabilityMetrics()`, with an independent failure mode from the other
three tiers. `buildCachedScoreReport()` (the homepage/showcase path) always
passes `cacheOnly: true` — a miss there returns the section omitted, never a
live billed call. Its baseline (`WALKABILITY_BASELINE_PER_BUCKET`) is
reasoned, not sampled, for the same cost reason.

## Mongo

No 2dsphere index anywhere — spatial filtering is Socrata's/the in-memory
grid's job; every cache lookup is an exact match on a *rounded* coordinate.

| Collection | Holds | TTL |
|---|---|---|
| `complaint_cache` | 311 counts + `bucketStatusCounts` + per-tier explanation, keyed `{lat, lng, radiusTier}` | 24h, sliding (refreshed on every write) |
| `trend_cache` | `/api/trend` series, keyed `{lat, lng, radiusTier, months}` | 24h |
| `complaint_groups_cache` | grouped complaint-browser rows, keyed `{lat, lng, radiusTier}` (no `months` — a shorter window is a prefix) | 24h |
| `amenity_distance_cache` | Google-routed walking distances per amenity bucket, keyed `{lat, lng}` | 180d |
| `walkability_cache` | raw Places results, keyed at ~111m precision | 30d |
| `baseline` / `amenity_baseline` | the citywide percentile baselines, `_id: "v1"` | none — refreshed only by rerunning the build scripts |
| `address_lookups` | address text ↔ coordinate + lookup counter, for `/api/showcase` | **none** — this is a name mapping, not a data cache, and must outlive the 24h counts it's paired with |

**Every collection's indexes are built lazily**, memoized per process, from
inside that collection's own provider functions (`ensure*Indexes()`) —
**never** from `src/index.js`. That file has a startup phase; the Vercel
entrypoint (`api/index.js`) does not — each request is its own short-lived
invocation, so code that only runs at `src/index.js` boot never executes in
production. `src/index.js` still calls them too, purely as a latency
optimization for the long-running paths (Docker, `npm run dev`).

## AI explanation layer

**Only the whole-report `summary` (`tier=overall`) ever goes through an AI
model.** Every per-section explanation (both complaint tiers, all four
amenity tiers) is a deterministic template, computed inline on
`POST /api/score` — this used to not be true (each section had its own AI
path), but those six calls were being made unconditionally on every
uncached view while the text was never rendered anywhere; removed.

Two adapters behind one interface, swapped by `AI_PROVIDER`:
`ollama` (local dev only — needs a running local Ollama, can't run on
Vercel) and `gemini` (works anywhere, including serverless). Both implement
`generateExplanation({ sections }) -> Promise<string>`, built from
`providers/ai/prompt.js#buildOverallSummaryPrompt()` — the one prompt either
adapter sends; **never diverge prompt rules per adapter.**

Prompt rules (baked into `prompt.js`): base the summary only on the given
sections, never invent addresses/dates/incidents; no ratios or "X times
more" comparisons (the model has done real arithmetic wrong before);
distances quoted in imperial units, as given, never recomputed; every count
described must use the word "complaints," never phrased as a fact about the
building itself (a real failure mode: a zero heat-complaint count summarized
as "there is no heat," the opposite of what a zero-complaint record means).

**Fallback is not optional.** `services/explain.js` wraps every AI call in
try/catch; any failure (timeout, rate limit, provider down) falls through to
a deterministic template. The AI feature must never show a broken or empty
state.

**Caching and staleness.** The summary is generated once and cached, stamped
with `basedOn` — the complaint-counts timestamp it describes. A cached
summary is only trusted when `basedOn` matches the *current* counts
timestamp; otherwise it regenerates. This exists because the summary's own
cache TTL is independent of the counts documents it describes — without the
stamp, a counts refresh could outlive a cached summary that was written
about the old numbers.

**Model deprecation is a live risk, not a one-time note.** Model strings live
in exactly one place (`AI_MODELS` in `constants.js`) for this reason — the
originally-planned Gemini model was already unavailable to new keys by the
time this was verified live. Confirm the configured model is still served
before assuming an old note here is current.

## Deployment (Vercel)

- `api/index.js` exports the built Express app directly — Vercel's Node
  runtime calls it with plain `(req, res)`, which an Express app already
  implements. No serverless adapter needed.
- Every collection's indexes are lazy (see Mongo section above) — this is
  the thing that makes the app correct on Vercel, not just fast.
- Mongo client is cached on `globalThis` (a `Symbol.for()`-keyed slot, which
  survives module-registry rebuilds under serverless instance reuse / `node
  --watch` the way a module-local memo does not), pool bounded at
  `MONGO_MAX_POOL_SIZE` (10) against Atlas's connection cap.
- Dev and prod point at different databases; no code branches on this — only
  `MONGODB_URI`/`MONGODB_DB` differ. Prod values are recorded in
  `.env.production.example`.
- Every env var degrades gracefully except `CRON_SECRET`, which **fails
  closed**: unset, `GET /api/warm` and `GET /api/refresh-amenities` both
  answer 503 rather than becoming open, expensive, unauthenticated endpoints.
- Function execution cap is confirmed **300s** (Fluid Compute enabled) —
  this is why `SOCRATA_TIMEOUT_MS` can afford to be 25s × 3 retries, and why
  the AI call was moved off the score request as a latency/UX choice rather
  than a timeout necessity.

## Conventions

- **Live-proxy + cache, not bulk ingest.** The dataset has hundreds of
  millions of rows; the backend never stores more than aggregate counts per
  coordinate and a bounded number of individual points/rows.
- Validate coordinates against `NYC_BOUNDS` (`lib/validate.js`); 400 on bad
  input.
- Every route that can reach an upstream API or spend money is rate limited
  (`lib/rateLimit.js`), tiered by cost, not by how the request looks — see
  [`backend-config-and-scripts.md`](../documentation/backend-config-and-scripts.md#showcase--rate-limits).
- Do not put personal data or coordinates in logs beyond what debugging
  needs. Nothing in this system stores caller identity — `address_lookups`
  and rate-limit buckets key on the address/IP, never a session or account.
- AI adapters are provider-agnostic at the call site (`services/explain.js`).
  Never branch on `AI_PROVIDER` outside `providers/ai/index.js`.
- Complaint-type strings, status strings, and amenity bucket definitions are
  each centralized in exactly one place in `config/constants.js`. Import
  them; never re-derive or duplicate the list elsewhere.
