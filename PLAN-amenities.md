# Amenity Scores: Transit, Parks, Bike

## Context

Streetwise today answers one question well — *is this building well-maintained,
and is this block liveable?* — by scoring NYC 311 complaints against a citywide
percentile baseline. But someone deciding where to live is also asking a second
question the app is silent on: *can I actually get anywhere from here?*

This adds three new top-level scores — **Transit Access**, **Parks Access**, and
**Bike Access** — bringing the report to five categories. They are deliberately
the *cheap* half of the amenity problem: unlike crime (a second Socrata pipeline)
or walkability (billed Google Places calls), all three come from small, static,
slow-changing public datasets that can be distilled once and answered from memory
in microseconds. No live upstream call sits on the request path.

Two properties of the existing system make this much less work than it looks:

1. **`bucketScore()` is already the right shape.** [`scoring.js:132`](backend/src/services/scoring.js#L132)
   is `100 - percentileFor(count)` — lower input, better score. Because these
   scores are **distance to the nearest thing**, lower is better there too. The
   entire percentile curve, anchor interpolation, band mapping, and aggregation
   are reused *unmodified*.
2. **`ScoreSection<T>` is already generic.** [`types.ts:38`](frontend/lib/types.ts#L38)
   parameterises over its counts type, so the amenity shape slots alongside it
   rather than replacing it.

**Outcome:** five scored panels, two verdict headlines (liveability and access),
a monthly-refreshable static dataset layer, and no new latency on `POST /api/score`.

---

## Decisions taken (and why)

| Decision | Choice | Rationale |
|---|---|---|
| Score structure | Three separate top-level scores | Your call. Costs a frontend restructure; §F1–F6 contain it. |
| Metric | **Distance scored, count shown** | Distance is lower-is-better, so `bucketScore()` needs **zero changes**. `within` is display-only context. |
| Data residency | Committed JSON, Mongo-writable | Mirrors [`baseline.js:100-120`](backend/src/providers/baseline.js#L100-L120) exactly. |
| Refresh | Vercel cron → Mongo, file fallback | Your call. See §B6 for the timeout caveat. |
| Bike scope | Citi Bike docks + DOT lanes | Lane geometry is handled by **densification** (§B2), not point-to-segment math. |
| Headline | **Two verdicts, side by side** | Your call. Liveability ≠ access; one band cannot honestly express both. |

### The one non-obvious architectural decision

**Amenity tiers must NOT go into `RADIUS_TIERS`.** That constant is Socrata-coupled
by derivation: [`constants.js:66-72`](backend/src/config/constants.js#L66-L72) builds
`TYPE_TO_BUCKET` by flat-mapping every tier's `buckets`, and `ALL_COMPLAINT_TYPES`
feeds the SoQL `in (...)` clause. Adding a `transit` tier there would inject
`"subway"` and `"bus"` into live 311 queries. Likewise `ALL_TIERS` at
[`scoreService.js:36`](backend/src/services/scoreService.js#L36) drives the Socrata
fan-out — a static tier would trigger an HTTP call for data already in memory.

Amenity tiers get a **parallel `AMENITY_TIERS` constant** with its own bucket shape.
This makes the hazard unrepresentable rather than merely avoided.

The same reasoning applies to the baseline: `isValidBaseline`
([`baseline.js:41-53`](backend/src/providers/baseline.js#L41-L53)) rejects any doc
missing *any* bucket in `ALL_BUCKETS`. Adding amenity buckets to `BUCKET_NAMES`
would **instantly invalidate the committed `baseline.json`** and fail
`test/baseline.test.js`. Amenities get their own baseline file and loader.

---

# Part A — Data pipeline

## A1. Sources — ALL DATASET IDs NEED VERIFICATION FIRST

Following the house convention in `backend/CLAUDE.md` ("OPEN ITEMS — verify
against live API before building on top"), these are **starting points, not
confirmed**. The first implementation step is a verify script, not a fetch.

| Bucket | Source | Geometry | Est. rows |
|---|---|---|---|
| `subway` | NYC OD — Subway Entrances | Point | ~1,900 |
| `bus` | MTA GTFS `stops.txt` (all boroughs) | Point | ~15,000 |
| `rail` | LIRR + Metro-North stations | Point | ~150 |
| `park` / `playground` / `garden` | NYC OD — Parks Properties, split on `typecategory` | Polygon → **centroid** | ~2,000 |
| `bikeShare` | Citi Bike GBFS `station_information.json` | Point | ~2,200 |
| `bikeLane` / `protectedLane` | NYC DOT Bicycle Routes, split on facility class | **LineString** | ~20,000 features |

**New: `backend/scripts/verifyAmenities.js`** (`npm run verify:amenities`), modelled
on [`verifyDataset.js`](backend/scripts/verifyDataset.js). Confirms each dataset ID
resolves, prints the actual field names and row count, and reports the share of
rows with usable geometry. **Run and record results in `CLAUDE.md` before writing
the build script.** Every ID above is a guess until this passes.

## A2. Distillation — the key trick

**New: `backend/src/lib/geo.js`** — pure, no dependencies:

```js
/** Great-circle metres between two coordinates. */
export function haversineMeters(lat1, lng1, lat2, lng2)

/**
 * Resamples a LineString into points every `spacingMeters` along its length.
 *
 * This is what collapses the bike-lane geometry problem into the same
 * nearest-point problem as every other dataset. Distance-to-nearest-densified-
 * point overestimates true distance-to-segment by at most spacingMeters/2 —
 * 12.5m at 25m spacing, well inside the resolution anyone acts on. The
 * alternative (point-to-segment projection over every vertex pair) is more
 * code, more per-request work, and buys precision the score cannot use.
 */
export function densifyLine(coordinates, spacingMeters)
```

**New: `backend/scripts/buildAmenities.js`** (`npm run build:amenities`), following
[`buildBaseline.js`](backend/scripts/buildBaseline.js)'s structure exactly: long
rationale docblock → `--key=value` arg parsing → `--dry-run` → **a refuse-to-write
sanity guard** → pretty table to stdout → write + `"COMMIT THIS FILE"`.

Output — three files in `backend/src/config/amenities/`, kept separate so a bike
refresh produces a readable git diff and so no single Mongo document approaches
the 16MB BSON limit:

```
transit.json   { subway: [...], bus: [...], rail: [...] }
parks.json     { park: [...], playground: [...], garden: [...] }
bike.json      { bikeShare: [...], bikeLane: [...], protectedLane: [...] }
```

Point encoding — **flat numeric triples, not objects**, with names in a parallel
array. For `bikeLane` this is the difference between ~4MB and ~1.2MB:

```jsonc
{
  "subway": {
    "pts": [40.7359, -73.9911, 0,  40.7306, -73.9866, 1],  // lat, lng, nameIdx
    "names": ["14 St-Union Sq", "1 Av"],
    "n": 2
  },
  "bikeLane": {
    "pts": [/* densified at 25m; nameIdx -1 = unnamed */],
    "names": [],
    "n": 48213
  }
}
```

The sanity guard: refuse to write if any bucket's row count falls more than **30%**
below the committed file's. That is the entire defense against a truncated
download silently degrading every score in the city.

## A3. Spatial index

**New: `backend/src/providers/amenities/spatialIndex.js`**

A uniform grid hash, built once per dataset at load. No dependency, ~60 lines.

```js
/**
 * Builds an O(1)-ish nearest-neighbour index over a flat [lat,lng,nameIdx,...]
 * array.
 *
 * Grid, not a k-d tree: cells are keyed on coordinates rounded to
 * AMENITY_GRID_DEGREES (~0.005 deg, ~450m), which is the same rounding idiom
 * the cache already uses (roundCoord, cache.js:47). A linear scan over 48k
 * densified bike-lane points is ~1ms, which is survivable but paid on every
 * request; the grid makes it ~5us and costs one Map.
 */
export function buildIndex(points, names) {
  return {
    /** @returns {{meters: number, name: string|null}|null} null past maxMeters. */
    nearest(lat, lng, maxMeters),
    /** @returns {number} how many fall inside radiusMeters. */
    countWithin(lat, lng, radiusMeters),
  };
}
```

`nearest()` searches the containing cell, then expands ring by ring, stopping once
the current best distance is smaller than the next ring's minimum possible
distance. `countWithin()` scans every cell the radius touches.

---

# Part B — Backend

## B1. `backend/src/config/constants.js` — additions only

Appended in a new `// --- Amenity tiers ---` banner section, in the file's
established prose-comment style. **`RADIUS_TIERS`, `BUCKET_NAMES`, `BUCKET_WEIGHTS`,
`TYPE_TO_BUCKET` are not touched** — see the architectural note above.

```js
/**
 * Static-dataset tiers, scored by DISTANCE rather than complaint count.
 *
 * Deliberately NOT part of RADIUS_TIERS. That constant is Socrata-coupled by
 * derivation — TYPE_TO_BUCKET (L66) flat-maps every tier's `buckets` into the
 * SoQL `in (...)` clause, and scoreService's ALL_TIERS (L36) fans out one HTTP
 * call per tier. A static tier added there would put "subway" into a 311 query
 * and pay a network round trip for data already in memory. Keeping the two
 * structures separate makes that unrepresentable rather than merely avoided.
 */
export const AMENITY_TIERS = {
  transit: {
    tier: "transit",
    radiusMeters: 800,        // ~10 min walk, the standard transit walkshed
    dataset: "transit",
    buckets: ["subway", "bus", "rail"],
  },
  parks: { tier: "parks", radiusMeters: 800, dataset: "parks",
           buckets: ["park", "playground", "garden"] },
  bike:  { tier: "bike",  radiusMeters: 800, dataset: "bike",
           buckets: ["bikeShare", "bikeLane", "protectedLane"] },
};

export const AMENITY_BUCKET_NAMES = Object.fromEntries(
  Object.entries(AMENITY_TIERS).map(([tier, { buckets }]) => [tier, buckets])
);

/**
 * Past this, "the nearest one" stops being a fact about this address and starts
 * being a fact about the city. Scored as the cap and flagged low-confidence
 * rather than reported as a distance nobody would walk.
 */
export const AMENITY_MAX_METERS = 2000;
export const AMENITY_GRID_DEGREES = 0.005;
export const AMENITY_LANE_SPACING_METERS = 25;
export const AMENITY_WALK_METERS_PER_MIN = 80;   // ~4.8 km/h
export const AMENITY_BASELINE_COLLECTION = "amenity_baseline";
export const AMENITIES_COLLECTION = "amenity_datasets";
export const AMENITY_WEIGHTS = { subway: 2, bus: 1, rail: 1, /* ...all nine... */ };
```

`AMENITY_WEIGHTS` is separate from `BUCKET_WEIGHTS` so the existing
`test/constants.test.js:100-105` assertion (weights ≡ flattened `BUCKET_NAMES`)
keeps passing untouched. Subway weighted 2× because for most New Yorkers it is
the deciding factor — an explicit, editable judgement rather than one smuggled in
by padding a bucket list, the failure mode `CLAUDE.md` decision 6 warns about.

## B2. `backend/src/providers/amenities/index.js` — Mongo, then file

Mirrors [`baseline.js:90-120`](backend/src/providers/baseline.js#L90-L120)
structurally: module-scope promise memo, rejection clears it, Mongo wins so a
refresh needs no redeploy, committed file means a fresh clone with no `.env`
still scores.

```js
/**
 * Every amenity dataset, indexed and ready to query. Memoized per PROCESS —
 * this is ~5MB of points, and rebuilding the grid per request would dominate
 * the request it is meant to make free.
 *
 * Mongo first, committed file second — the same order and the same reasons as
 * providers/baseline.js. Unlike the caches there is NO TTL: this is reference
 * data, and expiring it would leave nothing to score against.
 */
export async function loadAmenities({ forceRefresh = false } = {})
export function resetAmenitiesMemo()          // test seam, mirrors resetBaselineMemo
export async function saveAmenityDataset(name, doc)   // never throws; returns bool
export const AMENITY_FILE_PATHS = { transit, parks, bike }
```

**Validation before use** — the direct analogue of `isValidBaseline`: every bucket
present, `pts.length % 3 === 0`, `n` matching, every coordinate inside
`NYC_BOUNDS` ([`constants.js:576`](backend/src/config/constants.js#L576)). A doc
failing validation is skipped with a warning and the next source is tried, so a
corrupt Mongo write degrades to the committed file rather than to broken scores.

## B3. `backend/src/services/amenityService.js` — new

```js
/**
 * Distance-and-count metrics for every amenity bucket at one point.
 *
 * NO CACHE, deliberately. The 311 tiers cache because they cost a 0.3-2.5s
 * Socrata call; this is an in-memory grid lookup measured in microseconds, so a
 * Mongo round trip to avoid it would be slower than the work it skips.
 *
 * @returns {Promise<Record<string, Record<string, {meters, within, name}>>>}
 *   tier -> bucket -> metric. `meters` is null past AMENITY_MAX_METERS.
 */
export async function getAmenityMetrics(lat, lng)
```

Not coordinate-rounded, unlike `getCounts` — rounding exists to make a cache key
agree with the circle it describes ([`scoreService.js:64`](backend/src/services/scoreService.js#L64)),
and with no cache there is no key to agree with. The raw coordinate is strictly
more accurate.

## B4. `backend/src/services/scoring.js` — one new function, nothing modified

`bandFor`, `percentileFor`, `bucketScore`, `anchorsFor`, `normalizeAnchors` are
**unchanged**. Distance is already lower-is-better, which is what the inverted
curve at L132 expects.

```js
/**
 * Scores one amenity tier. Structurally parallel to scoreTier (L160) and
 * returns the same frozen key set with `metrics` in place of `counts`.
 *
 * Distances go through the SAME inverted percentile curve as complaint counts,
 * unmodified — 0m means standing on it, which scores 100, exactly as 0
 * complaints does. That is not a coincidence worth being clever about; it is
 * why distance was chosen as the metric over a count.
 *
 * A null distance (nothing within AMENITY_MAX_METERS) scores as the cap and is
 * flagged low-confidence per bucket. Reporting 0 for "none nearby" would be
 * indistinguishable from "one right here".
 */
export function scoreAmenityTier(tierName, metrics, amenityBaseline)
```

Aggregation reuses the existing weighted-mean shape but reads `AMENITY_WEIGHTS`.
Extract the loop body of `aggregate` (L142-151) into
`weightedMean(scores, weights)` and have both callers pass their own table —
`aggregate` becomes a one-line wrapper, so the existing tests are untouched.

`buildReport` (L235) gains three lines and a second baseline argument:

```js
export function buildReport(counts, baseline, meta = {}, amenities = null, amenityBaseline = null) {
  return {
    address: null,
    buildingHealth: scoreTier("building", counts?.building, baseline),
    blockQuality: scoreTier("block", counts?.block, baseline),
    // Null when the amenity datasets failed to load. Omitted rather than
    // zero-scored: a missing dataset is not an address with no subway.
    ...(amenities ? {
      transitAccess: scoreAmenityTier("transit", amenities.transit, amenityBaseline),
      parksAccess:   scoreAmenityTier("parks",   amenities.parks,   amenityBaseline),
      bikeAccess:    scoreAmenityTier("bike",    amenities.bike,    amenityBaseline),
    } : {}),
    meta: { /* unchanged */ },
  };
}
```

Trailing optional parameters, so every existing call site and test compiles unchanged.

## B5. Amenity baseline

**New: `backend/scripts/buildAmenityBaseline.js`** (`npm run baseline:amenities`)
→ writes `backend/src/config/amenityBaseline.json`, same `{median, p90, zeroShare, n}`
per bucket shape the scorer already reads.

This is where the "free" claim is honest but not absolute: you *do* need a
baseline, because percentile-vs-citywide is the whole defensibility argument.
But it reuses `buildBaseline.js`'s seeded Mulberry32 sampler and borough quotas
against **local data only** — zero network, seconds not the ~62s the 311 baseline
costs. Import the sampler rather than copying it: extract
`sampleCoordinates({ size, seed })` from `buildBaseline.js` into
`backend/scripts/lib/sampleCoords.js` and have both scripts call it.

**New: `backend/src/providers/amenityBaseline.js`** — a near-copy of
`baseline.js` pointed at `AMENITY_BASELINE_COLLECTION` and the new file. Kept
separate rather than generalised: merging would put amenity buckets into
`isValidBaseline`'s `ALL_BUCKETS` and invalidate the committed `baseline.json`.

> **Note for the scorer:** distances are continuous and not zero-inflated, so the
> `zeroShare` anchor branch at [`scoring.js:66`](backend/src/services/scoring.js#L66)
> is inert here — `zeroShare` will be ~0 and the curve runs through
> `[0,0] → [median,50] → [p90,90] → tail`. That is correct, not a bug, and worth
> a comment in the generated JSON so nobody "fixes" it later.

## B6. Routes and the monthly cron

**`backend/src/routes/score.js`** — unchanged. `buildScoreReport` adds
`getAmenityMetrics` and `loadAmenityBaseline` into its existing `Promise.all`
([`scoreService.js:151`](backend/src/services/scoreService.js#L151)), so amenities
cost no wall-clock time. Wrap in `.catch(() => null)` so an amenity failure
degrades to a two-category report rather than a 500.

**`backend/src/routes/explanation.js`** — `validateTier` widens to
`Object.keys(RADIUS_TIERS)` ∪ `Object.keys(AMENITY_TIERS)`. Wire ids are the short
forms — `transit`, `parks`, `bike` — matching the existing `building`/`block`
convention.

**New: `GET /api/refresh-amenities`** in a new `backend/src/routes/amenities.js`,
authenticated with `CRON_SECRET` via the existing `bearerAuthStatus` pattern from
[`showcase.js:158-180`](backend/src/routes/showcase.js#L158-L180). Registered in
`vercel.json` on `0 6 1 * *`.

> ### Cron scope: `bikeShare` only — settled
>
> **Not a timeout constraint.** Vercel's Hobby execution cap is **300s**, not the
> "~10s" `CLAUDE.md` records — that figure was explicitly flagged there as
> unverified ("verify actual current limit on Vercel's own pricing page before
> assuming") and is wrong. The full distillation would fit comfortably.
>
> The reason is **signal, not capacity.** Citi Bike genuinely churns month to
> month — docks open, close, and move. Subway entrances, park boundaries, and DOT
> lane geometry change on a scale of *years*. Re-downloading them monthly buys
> nothing and adds a monthly opportunity for an upstream hiccup to overwrite good
> committed data with a truncated file.
>
> So: the cron refetches GBFS `station_information.json` (one small JSON) and
> writes the `bikeShare` bucket to Mongo. The other five buckets stay
> committed-file-only, refreshed by rerunning `npm run build:amenities` when a
> source actually changes. `loadAmenities()` reads Mongo-then-file uniformly
> regardless, so widening the cron later is a scope change, not an architectural
> one.
>
> **Deliverable: correct the cap in `backend/CLAUDE.md`.** The Deployment section
> still says "reportedly ~10s"; it is 300s on Hobby. That stale figure is load-
> bearing — it is one of the stated reasons the AI explanation call was split off
> the score path — so leaving it wrong invites a future decision built on it, the
> same way this plan's first draft was.

## B7. Explanations

[`explain.js:13-23`](backend/src/services/explain.js#L13-L23) — `TIER_LABELS`
gains three entries; `radiusLabelFor`'s `tier === "building" ? ... : ...` ternary
becomes a lookup table (it silently mislabels any third tier today).

`explanationInputFor` (L29) passes `counts: subScore.counts ?? subScore.metrics`.
**`prompt.js` needs a distance-aware variant** — the current prompt describes
complaint counts, and handing it `{subway: {meters: 240}}` produces text about
"240 subway complaints". Add a second prompt shape selected on tier kind, keeping
both in `prompt.js` so the tone rules stay in one file per `CLAUDE.md`.

`hasAnyComplaints` (L39) short-circuits to the template when everything is zero.
The amenity analogue is the opposite: all-null (nothing nearby) is the case most
worth explaining. Add `hasAnyAmenity` rather than reusing it.

---

# Part C — Frontend

Detailed design in §F1–F6. The through-line: **the fixed arity React forces on us
is written in exactly one place, and its type makes drift a build error.**

## F1. Types — `frontend/lib/types.ts`

Extract `SectionBase` (field-for-field what `ScoreSection` has today, so nothing
that consumes it changes), then:

```ts
export interface AmenityMetric {
  /** Metres to the nearest one. Null means nothing inside the cap — a real
   *  answer for much of Staten Island, not a fetch failure. */
  meters: number | null;
  /** How many inside radiusMeters. DISPLAY ONLY — never scored, because three
   *  bus stops on one corner is not three times the access. */
  within: number;
  /** e.g. "14 St-Union Sq". Null when the dataset had no name. */
  name: string | null;
}

export interface AmenitySection<TMetrics extends Record<string, AmenityMetric>>
  extends SectionBase {
  metrics: TMetrics;
  bucketScores: Partial<Record<keyof TMetrics, number>>;
  bucketConfidence: Partial<Record<keyof TMetrics, "low">>;
}
```

`ReportResponse` gains three **named** fields — not a `Record`, not a discriminated
union. Named fields keep `report.transitAccess.metrics.subway.meters` fully typed,
and keep `ShowcaseItem extends Omit<ReportResponse, "address">`
([`types.ts:80`](frontend/lib/types.ts#L80)) true to what the backend literally
returns. The three new fields are **optional** (`transitAccess?`) because
`/api/showcase` serves Mongo-cached documents that can predate this feature.

`meta.cache` becomes `Partial<Record<CategoryId, "hit" | "miss">>` — partial so a
mid-rollout backend isn't a compile error for a field that, per grep, **has zero
readers**. Worth deleting instead; flagging rather than deciding.

Two key unions, deliberately distinct:

```ts
/** Field names on ReportResponse. */
export type CategoryKey = "buildingHealth" | "blockQuality"
  | "transitAccess" | "parksAccess" | "bikeAccess";
/** The `?tier=` wire value. Separate axis — the API already says "building". */
export type CategoryId = "building" | "block" | "transit" | "parks" | "bike";
export type ComplaintTierId = "building" | "block";
```

## F2. Registry — new `frontend/lib/categories.ts`

No JSX, so `lib/score.ts` and `lib/hooks.ts` can import it without pulling a
component graph in. Icons live separately in `components/categoryIcons.tsx` as a
**total** `Record<CategoryKey, IconComponent>`, so a category without an icon
fails the build.

Exports `COMPLAINT_CATEGORIES` and `AMENITY_CATEGORIES` as **two separately
narrowed lists**, composed into `CATEGORIES`. Not one list filtered — 
`CATEGORIES.filter(c => c.kind === "complaints")` returns the wide union, so
`report[c.key]` would no longer satisfy `ScorePanelCard`'s `panel` prop.

Each entry: `{ key, id, kind, label, description, colorVar, ringLabel }`.

## F3. The hooks problem — new `useReportPanels` in `frontend/lib/hooks.ts`

[`ReportView.tsx:39-56`](frontend/components/ReportView.tsx#L39-L56) calls
`useNearbyComplaints` and `useExplanation` in hardcoded pairs. React's Rules of
Hooks forbid looping over the registry to fix this.

Rejected: pushing `useExplanation` into each panel (the way `TrendSection`
self-fetches). `TrendSection` gets away with it because nothing outside consumes
its series — and even so it needed an `exhaustive-deps` escape hatch at
[`TrendSection.tsx:81`](frontend/components/TrendSection.tsx#L81). Explanations
are consumed by `VerdictBanner`, which sits *above* the panels, so self-fetching
means five callbacks lifting strings back up through a render cascade.

Instead: **one hook holding the app's only fixed-arity fanout**, with five
hand-written `useExplanation` calls and two `useNearbyComplaints` calls (amenities
have no complaint feed and no time series). Its return type is a **total**
`Record<CategoryKey, ...>` — so adding a sixth `CategoryKey` is a *build error
inside this hook* until a line is added. The registry and the fanout cannot
silently drift.

Gate on the **section** argument, not on `coords`: passing `coords: undefined`
while a section is present makes `useExplanation` return the section's cached AI
text ([`hooks.ts:192`](frontend/lib/hooks.ts#L192)) rather than null.

**Also fixes a bug this change would otherwise amplify:**
[`ReportView.tsx:65`](frontend/components/ReportView.tsx#L65) blanks the entire
banner to "Reasoning…" while *any* tier is in flight. At five categories that
means waiting on the slowest of five model calls. Replace with per-category
gating — a category joins the banner once it settles, with one trailing pulse
beneath. A category in flight is **skipped, not templated**, since showing
template text and swapping to AI text is a visible rewrite under the reader's eyes.

## F4. Panels — sibling card, shared shell

**Do not** widen `ScorePanelCard`'s `panel` prop to a union. It owns two
`useState`s, a date-cutoff `useMemo`, `TrendSection`, and `RecentComplaintsList` —
none of which mean anything for a subway station — and
[`ScorePanelCard.tsx:76`](frontend/components/ScorePanelCard.tsx#L76) sums
`Object.values(panel.counts)`, undefined for amenities. The decisive argument:
a sibling means **`ComplaintBreakdownBars.tsx` does not change at all**, and its
eight hardcoded `tier === "building"` sentences (L78-111) never grow a third arm.

| New file | Contents |
|---|---|
| `components/PanelShell.tsx` | Exactly [`ScorePanelCard.tsx:94-147`](frontend/components/ScorePanelCard.tsx#L94-L147) — card, header, meter row, band badge, confidence callout — with the complaint-count line becoming a `summary` slot. Both card kinds render it, so the header and meter stay pixel-identical. |
| `components/AmenityPanelCard.tsx` | `PanelShell` + three metric rows. Summary line shows the **best** of the three ("Nearest is 14 St–Union Sq, 3 min walk") — one 2-minute subway beats three 12-minute buses. |
| `components/AmenityMetricRows.tsx` | Per bucket: label + `name` on the left, walk time + `N within 800m` on the right. The `name` is what makes a row checkable — "0.3 mi to transit" is a claim, "14 St–Union Sq" is a verifiable fact. |
| `lib/amenities.ts` | `formatWalk(meters)`, `nearestMetric(metrics)`, so no component reimplements the pace constant. |

**Flagged as a bad idea: an amenity `explain()`.** A client-side prose generator
would sit next to the backend's own `explanation` for the same section, free to
disagree — exactly the hazard [`ComplaintBreakdownBars.tsx:20-23`](frontend/components/ComplaintBreakdownBars.tsx#L20-L23)
warns about. Amenity panels get no per-panel "why" in v1; the prose is in the banner.

## F5. Deduplicate — new `components/ReportBody.tsx`

[`ReportView.tsx:153-198`](frontend/components/ReportView.tsx#L153-L198) and
[`CompareColumn.tsx:70-105`](frontend/components/CompareColumn.tsx#L70-L105) are
already near-identical. Extract before adding, or every category is edited twice.

Props: `{ report, coords, address, layout: "page" | "column", aiExplanation?, complaints? }`.
The compare view passes neither optional — which is exactly how it already hides
complaint lists ([`ScorePanelCard.tsx:175`](frontend/components/ScorePanelCard.tsx#L175))
— and **gains the three amenity scores for free**.

Layout — two sibling grids, not one six-column grid with span arithmetic:

```
Row 1 (charts):    mt-4 grid gap-4 lg:grid-cols-2
Row 2 (amenities): mt-4 grid gap-4 md:grid-cols-3
```

Chart panels never drop below 480px, preserving the ~290px sparkline-collision
constraint noted at [`ReportView.tsx:161-163`](frontend/components/ReportView.tsx#L161-L163).
Amenity panels bottom out at 229px at `md`, which has no axis labels to collide.
**No `sm:grid-cols-2` on row 2** — three items in two columns leaves an orphan hole.

Write Tailwind classes as **whole literals**, never interpolated — v4's scanner
does literal source matching.

**Map rings**: `MapPanel`'s two named radius props become `rings: MapRing[]`,
**deduplicated by radius** — all three amenity tiers are 800m, so a naive
per-category map draws three identical circles and three identical legend rows.
Its effect ([`MapPanel.tsx:199`](frontend/components/MapPanel.tsx#L199)) currently
depends on two number primitives; an array prop gives fresh identity every render
and would **rebuild the WebGL context and tile chain on every render**. Depend on
a serialised `ringsKey` string instead.

## F6. Two verdicts — `frontend/components/VerdictBanner.tsx`

Your chosen design. The banner splits into two halves with **two separate
vocabularies**, because the existing `BAND_VERDICT`
([`score.ts:15`](frontend/lib/score.ts#L15)) is habitability language:

| Band | `BAND_VERDICT` (liveability) | New `ACCESS_VERDICT` |
|---|---|---|
| good | Looks solid | Well connected |
| fair | Worth a closer look | Some trade-offs |
| poor | Significant red flags | Car-dependent |

This is precisely what keeps the banner honest. Folding all five into one band
would let a spotless building 900m from a train render "Significant red flags",
and — because [`score.ts:63`](frontend/lib/score.ts#L63) filters for sections
matching the overall band and would find none — fall through to *"Rated Poor based
on limited complaint data"*, which is false. Two headlines make that
unrepresentable.

Helper changes in `lib/score.ts`:

```ts
/** Worst band of any number of sections. Variadic, so the existing
 *  two-argument call sites compile unchanged. Zero args → "good", the correct
 *  identity for a worst-of fold. */
export function overallBand(...bands: ScoreBand[]): ScoreBand
```

> Do **not** tighten this to `(first, ...rest)`. It looks safer but breaks
> `overallBand(...bands)` with TS2556 when `bands: ScoreBand[]`.

`explainVerdict` takes an **array** of complaint sections instead of two
positional ones (its body after L63 is already generic). A parallel
`explainAccess(sections, band)` builds the access half from the nearest metric of
whichever tier set the band.

`FeaturedCard` and `HeroSampleCard` show the liveability band as today plus the
access band as a secondary chip — without this a homepage card can say "Looks
solid" and open a report that says otherwise.

## F7. Files changed

**New (9):** `lib/categories.ts`, `lib/amenities.ts`, `components/PanelShell.tsx`,
`components/AmenityPanelCard.tsx`, `components/AmenityMetricRows.tsx`,
`components/ReportBody.tsx`, `components/categoryIcons.tsx`, plus backend
`providers/amenities/`, `services/amenityService.js`.

**Changed (19):** `lib/types.ts`, `lib/score.ts`, `lib/hooks.ts`, `lib/api.ts`,
`ReportView.tsx`, `CompareColumn.tsx`, `VerdictBanner.tsx`, `ScorePanelCard.tsx`,
`MapPanel.tsx`, `MapPanelLazy.tsx`, `TrendSection.tsx` (drops the L93 mislabelling
ternary), `icons.tsx`, `app/globals.css`, `FeaturedCard.tsx`, `HeroSampleCard.tsx`,
`ReportLoading.tsx`, `CompareView.tsx`, `ComplaintsBrowserModal.tsx`,
`RecentComplaintsList.tsx` (last two type-only, so they can never be handed an
amenity id).

**Deliberately untouched:** `ComplaintBreakdownBars.tsx`, `ScoreMeter.tsx`,
`StatusBadge.tsx`, `CitywideBaselinePanel.tsx`, `app/page.tsx`.

### Colour — the genuinely hard part

Five categorical hues that must stay distinct from three *status* hues, in both
themes. **Note the trap: green already means "good band"** (`--status-good: #179b60`),
so a green Parks icon beside a red "Poor" badge is actively misleading. Starting
candidates, all **unverified** — run the file's own contrast rule (graphic ≥3:1,
`-ink` ≥4.5:1 on `--surface-1`, both themes, plus a deuteranopia check against
`--status-good`): light `transit #0e7490` / `parks #4f7a21` (moss, not leaf) /
`bike #b83280`; dark `transit #38bdd8` / `parks #8fc44a` / `bike #e879b8`.

---

# Sequencing

Each step ends green, so a stall never leaves a half-built report.

1. **Verify the data.** `verifyAmenities.js`; record confirmed dataset IDs and
   field names in `CLAUDE.md`. **Nothing else starts until this passes** — every
   ID in §A1 is currently a guess.
2. **Geo + index**, pure and unit-tested: `lib/geo.js`, `spatialIndex.js`. Test
   `nearest()` against hand-computed distances and against a brute-force scan on
   random points.
3. **Build the data**: `buildAmenities.js` → three committed JSON files.
4. **Provider + service**: `providers/amenities/`, `amenityService.js`.
5. **Baseline**: extract `sampleCoords.js`, then `buildAmenityBaseline.js` →
   committed JSON, `providers/amenityBaseline.js`.
6. **Scoring**: `scoreAmenityTier`, `weightedMean` extraction, `buildReport`
   optional args. **Backend fully done and testable via curl at this point.**
7. **Explanations + routes**: prompt variant, `validateTier` widening,
   `/api/refresh-amenities` (bikeShare only), `vercel.json` cron. Also correct
   the Hobby execution cap in `CLAUDE.md` from "~10s" to 300s, and record the
   confirmed dataset IDs from step 1.
8. **Frontend types, registry, helpers** — no UI yet. `next build` green with the
   new fields unrendered.
9. **Chrome extraction, no behaviour change**: `PanelShell` + `ScorePanelCard`
   refactor. **Diff the report page against `main` — it must be pixel-identical.**
   This is where a regression is cheapest to catch.
10. **Amenity UI**, then **`ReportBody`** composition, then **dual banner**, then
    map rings and homepage cards.

---

# Verification

**Backend** (has a real test suite — 299 tests, no network):

```bash
cd backend
npm run verify:amenities          # step 1 gate: dataset IDs resolve
npm run build:amenities -- --dry-run
npm test                          # existing 299 must stay green
```

New tests, following house conventions (`vi.hoisted` + `importOriginal` mocks,
`test/helpers/mongoTestServer.js` for Mongo):
- `test/geo.test.js` — haversine against known NYC pairs; `densifyLine` spacing.
- `test/spatialIndex.test.js` — `nearest()` matches brute force over 1,000 random
  points; empty index returns null; `countWithin` boundary is inclusive.
- `test/amenityScoring.test.js` — property tests mirroring
  [`scoring.test.js:102-113`](backend/test/scoring.test.js#L102-L113): monotonic
  (farther is never a better score), clamped 0-100, null → cap + low confidence.
- `test/amenities.test.js` — Mongo-then-file fallback, corrupt doc → next source,
  memo reset.
- **`routes.test.js` additions** — the frozen-contract file. A five-section
  payload, and a report that still returns two sections when amenities fail to load.

> **`test/helpers/mongoTestServer.js:15-20` must gain `resetAmenitiesMemo` and
> `resetAmenityBaselineMemo`** in `resetIndexMemos()`, or those memos resolve
> against a stopped server and later suites fail confusingly.

**End-to-end**, both servers running:

```bash
curl -s localhost:3001/api/score -H 'content-type: application/json' \
  -d '{"lat":40.7215,"lng":-73.9878}' | jq '.transitAccess, .parksAccess, .bikeAccess'
```

Sanity checks that would catch a wrong index or a bad baseline:
- **123 Ludlow St** (the README's demo address) — dense LES, should score high on
  all three; nearest subway should name a real nearby station.
- **A Staten Island address** — should show `meters: null` on `subway` with
  low confidence, and *not* a zero-distance artifact.
- **Directly above a subway entrance** — near-zero metres, score ~100.
- Compare `nearest()` output against Google Maps walking directions for three
  addresses. A systematic overestimate points at the densification spacing; a
  wildly wrong answer points at swapped lat/lng in the distiller.

**Frontend** (no test framework — `tsc` is the only net, which is why F1/F2/F3 are
built so a missing hook call, icon, or registry entry is a *type* error):

```bash
cd frontend && npm run build
```

Then by hand: report page at all five breakpoints (375 / 640 / 768 / 1024 / 1440),
compare page with two addresses, both themes, and a homepage card whose cached
showcase document predates amenities — it must render two panels, not crash.

---

# Open risks

1. **Every dataset ID in §A1 is unverified.** Step 1 exists to resolve this;
   treat the source table as a hypothesis.
2. **A monthly Mongo write is a monthly chance to overwrite good data with bad.**
   The cron is scoped to `bikeShare` (§B6), so the blast radius is one bucket —
   but `saveAmenityDataset` must run the same §A2 sanity guard the build script
   does (refuse a >30% row-count drop) *before* writing, and `loadAmenities()`
   must validate on read so a bad doc falls through to the committed file.
   Belt and braces, because nothing downstream can tell a thin dataset from a
   genuinely dock-free neighbourhood.
3. **`bikeLane` file size.** ~48k densified points ≈ 1.2MB committed. Acceptable,
   but if the DOT dataset is larger than estimated, raise
   `AMENITY_LANE_SPACING_METERS` to 40m — the accuracy cost is ±20m, invisible at
   this resolution.
4. **Distance ≠ walking distance.** These are straight-line metres. A dock across
   a highway with no crossing scores as if adjacent. Honest fix is a routed
   walkshed, which needs a routing engine and is firmly out of scope — but the UI
   should say "3 min walk" only where it can, and the copy should not overclaim.
   Worth a `CLAUDE.md` caveat alongside the existing `streetCondition` null-rate one.
5. **Baseline geography.** A citywide transit baseline makes Manhattan look
   uniformly excellent and eastern Queens uniformly poor — which is *true*, but
   means the score has much less discriminating power within Manhattan than
   `blockQuality` does. Consider a per-borough baseline later; note it, don't
   build it now.
