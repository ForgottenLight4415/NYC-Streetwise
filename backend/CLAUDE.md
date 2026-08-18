# CLAUDE.md

## Project: "Should I Live Here" (NYC 311 address risk tool)

A hackathon web app. User enters an NYC address; app returns one report with two
scores: a Building Health Score and a Block Quality Score, both derived from NYC
311 complaint data. This file covers the BACKEND / DATA layer only (Person 1).

## What this backend does

- Exposes an API that takes a coordinate and returns two 0-100 sub-scores.
- Queries NYC Open Data 311 live, caches results in Mongo, scores them against a
  precomputed citywide baseline.
- Does NOT geocode. The frontend sends {lat, lng} from Google Places Autocomplete.

## Architecture

Three layers, kept separate for testability:
routes (Express) -> services (scoring + orchestration) -> providers (Socrata + cache)

The route never calls Socrata directly. Service checks cache, falls back to
Socrata provider, then runs scoring. Scoring is a pure function tested against
fixtures with no network.

## Data source

- Dataset: NYC 311 Service Requests, Socrata UID `erm2-nwe9`
- Endpoint: https://data.cityofnewyork.us/resource/erm2-nwe9.json
- Auth: Socrata app token in `X-App-Token` header (register one; unauthenticated
  requests throttle hard under load)

## Two scores, six buckets (RESOLVED — see complaint_type strings below)

Building Health (tight radius ~20-30m): heat/hot water, unsanitary condition, plumbing
Block Quality (wider radius ~300-400m): noise, parking, street condition

Both use the same lat/lng with different radius sizes. No BBL join (that field is
not reliably present in 311 data).

## complaint_type strings — CONFIRMED against live API (RESOLVED, was open item 1)

Pulled via `$select=complaint_type&$group=complaint_type` against erm2-nwe9. Full
distinct list has ~280 values; only the ones relevant to our six buckets are below.
Do not re-derive these from memory elsewhere in the codebase, import from constants.js.

```js
// constants.js

const BUILDING_HEALTH_TYPES = {
  heatHotWater: ["HEAT/HOT WATER", "Heat/Hot Water"],
  unsanitaryCondition: ["UNSANITARY CONDITION", "Unsanitary Condition"],
  plumbing: ["PLUMBING", "Plumbing"],
};

const BLOCK_QUALITY_TYPES = {
  noise: [
    "Noise - Residential",
    "Noise - Street/Sidewalk",
    "Noise - Vehicle",
    "Noise - Commercial",
  ],
  parking: ["Illegal Parking", "Blocked Driveway"],
  streetCondition: ["Street Condition", "Sidewalk Condition", "DEP Street Condition"],
};
```

Decisions made and why (do not silently change these without updating this file):

1. **Dirty Condition / Dirty Conditions excluded from Unsanitary Condition.** These
   are a separate DSNY street/curb sanitation complaint_type, distinct from HPD's
   Unsanitary Condition (building interior). Building Health should reflect landlord
   maintenance, not curb sanitation, so excluded.
2. **General Construction/Plumbing excluded from Plumbing.** Ambiguous DOB combined
   category, not clearly plumbing-specific. Excluded to avoid overcounting.
3. **Non-Residential Heat excluded from Heat/Hot Water.** Commercial, not relevant
   to a residential livability score.
4. **Noise scope limited to 4 of 9 possible noise types** (Residential,
   Street/Sidewalk, Vehicle, Commercial). Helicopter, Park, House of Worship, and
   generic "Noise" excluded as not representative of daily block-level noise
   experience for a resident. Revisit if scores feel too low in noise-heavy areas
   near flight paths or parks.
5. **Blocked Driveway folded into the parking bucket** alongside Illegal Parking.
   Blocked Driveway alone is 1,056,637 records citywide, larger than some of
   Illegal Parking's own minor variants, so this materially changes the bucket if
   omitted.
6. **Sidewalk Condition folded into streetCondition**, not a separate 4th bucket,
   to preserve even weighting across 3 buckets per score. If sidewalk condition
   ever needs its own weight, it must be split out explicitly in the scoring
   function, not just added to the type list.

**Critical implementation note on weighting:** `getCounts` MUST sum all string
variants within a bucket into ONE number before scoring. Do not compute a
percentile per string and average those, buckets have different variant counts
(noise has 4 strings, plumbing has 1), and per-string averaging would silently
underweight noise relative to plumbing.

## API contract (FROZEN once agreed with team; do not change unilaterally)

**CONTRACT CHANGE (post-freeze): explanationSource field + new /api/explanation
endpoint added below. Flag to Person 2 — this affects frontend swap-in-place UI.**

POST /api/score
  body: { lat: number, lng: number }
  returns: {
    address: null,
    buildingHealth: {
      score, band, counts: {heatHotWater, unsanitaryCondition, plumbing}, radiusMeters,
      explanation: string,               // AI text if cached, else template text
      explanationSource: "ai" | "template"
    },
    blockQuality: {
      score, band, counts: {noise, parking, streetCondition}, radiusMeters,
      explanation: string,
      explanationSource: "ai" | "template"
    }
  }
  ALWAYS FAST. Never blocks on an AI call. On cache miss, explanation is the
  deterministic template result, explanationSource: "template".

GET /api/explanation?lat=&lng=&tier=building|block
  returns: { explanation: string, explanationSource: "ai" }
  SLOW PATH. Only called by frontend when /api/score returned
  explanationSource: "template". Calls the active AI adapter (Ollama or Gemini
  per AI_PROVIDER), writes result to the SAME cache doc /api/score reads from,
  returns the real explanation once resolved. Synchronous (frontend waits on
  this one call, no polling) — deliberate hackathon simplification, not an
  oversight. Frontend swaps the template text for this result in place once
  it resolves; if /api/score already returned explanationSource: "ai", frontend
  skips this call entirely.

GET /api/complaints?lat=&lng=&radius=&limit=&tier=building|block
  returns: [ { unique_key, type, lat, lng, created_date, status }, ... ]
  headers: X-Complaints-Truncated, X-Complaints-Limit

  **CONTRACT CHANGE (post-freeze): `unique_key` added to the row shape, on this
  endpoint and on /api/complaints/group. Flag to Person 2.** Additive; existing
  callers ignoring it are unaffected. It is the dataset's own primary key -- the
  number a renter can quote to 311 -- and it is the ONLY field that identifies a
  row. The frontend previously displayed a "Complaint #" it had built itself
  from type + timestamp + row index, which read as a 311 reference but was an
  artifact of paging. Null on the mock path, where no real record exists; the
  frontend shows nothing rather than falling back to the synthetic id.

  **CONTRACT CHANGE (post-freeze): optional `tier` param added. Flag to Person 2.**
  Additive and backward-compatible — omitted, the query spans every type in both
  tiers exactly as before. Added because the frontend's per-tier report panels
  were showing the wrong complaints: within 25m of a dense Manhattan address
  there are 200+ noise records, so the untiered query exhausted the row limit on
  Block Quality types and the three Building Health types were crowded out of
  the result entirely. The panel then charted noise complaints under a "Building
  Health" heading whose own category counts said 12.

  Filtering client-side was rejected: it would mean re-deriving the
  complaint_type strings outside constants.js, which this file forbids.

  **CONTRACT CHANGE (post-freeze): grouped mode + months/bucket/status/offset
  params, four new headers, and a `statusBucket` field. Flag to Person 2.**

  All additive; the body is still a bare array and the default mode is byte-for-
  byte what it was. Two modes now:

    default        raw rows, newest first, exactly as before. Never fills the
                   grouped cache -- the fill was measured at 2.3-74.3s and must
                   not sit on the path to a page load.
    complete=1     one row per (day, complaint_type) with a status breakdown:
                   { day: "YYYY-MM-DD", type, counts: {open, in-progress,
                   closed}, total }. Filters: months (3|6|9|12|18|24, default
                   24), bucket (scoped to the tier), status (open|in-progress|
                   closed), offset, limit.

  New headers: X-Complaints-Total (GROUPS matching the filters, before paging --
  not the complaints inside them), X-Complaints-Offset, X-Complaints-Has-More,
  X-Complaints-Cached.

  WHY GROUPED. Socrata caps $limit at 50,000, and 655 E 230 St in the Bronx has
  190,205 block-tier rows inside a 350m/24mo window -- so no raw-row cache could
  ever hold that address. Grouping upstream via date_trunc_ymd collapses it to
  1,848 rows (102.9x). Measured over 12 locations 2026-08-17; the densest is
  Ludlow St at 2,929 grouped rows, which is what COMPLAINT_GROUPS_CACHE_LIMIT is
  sized against. Note the maximum is NOT the extreme address: volume
  concentrated in one type/status compresses hardest, so type DIVERSITY drives
  the group count.

  That address is not a geocoding artifact -- verified, address_type=ADDRESS on
  a real consistent address, with filings ~70s apart. It is serial repeat-
  filing. No coordinate-exclusion logic was added, and the verification argues
  against adding it: the records are genuine, so suppressing the coordinate
  would erase real signal. (Its 187,800 stacked noise records DO distort the
  score for nearby addresses. Open item, separate from this change.)

  Cached in its own `complaint_groups_cache` collection, keyed {lat, lng,
  radiusTier} with a 24h TTL, and NO months in the key -- rows are stored
  newest-day-first, so every window is a prefix of the one entry. Cache is read
  and written only when the radius matches the tier's own, since the key has no
  radius dimension.

GET /api/complaints/group?lat=&lng=&tier=&type=&day=&status=&offset=&limit=
  returns: [ { unique_key, type, lat, lng, created_date, status, statusBucket }, ... ]
  headers: X-Complaints-Limit, X-Complaints-Offset, X-Complaints-Has-More,
           X-Complaints-Total (only on the last page, where it is exact)

  **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.**
  The individual complaints behind one (day, type) row of the grouped browser.
  PAGINATED, not merely capped: the largest single group measured is 4,978 rows
  (655 E 230 St, 2025-01-05). Live and uncached -- 5.6s measured for a 17-row
  day, so the cost is the spatial filter rather than the rows, and a day+type
  cache would buy little. `radius` comes from the tier, not the caller, so a
  drill-in always describes the same circle as the group it came from.

  **BUGFIX (no contract change): `status` now filters in SoQL.** It used to
  narrow the page AFTER $offset/$limit had been applied, so the rows were drawn
  from every status and only then filtered -- a day with 100 complaints of which
  3 were open returned an empty list under a header correctly stating 3, and
  paging out of it was impossible. The bucket is expanded to raw statuses via
  rawStatusesForBucket() in constants.js, so the enum is still not duplicated.
  Note "open" is NOT a plain in-list: statusBucket() maps NULL and every
  unrecognised value there too, so the predicate matches the complement as well,
  keeping the filtered page total in the same way the grouped counts are.

  **BUGFIX: both grouped paths now query the ROUNDED coordinate**, as getCounts()
  already did. complaint_groups_cache keys on the rounded coord but the fill used
  the caller's raw one, so a hit and a miss described measurably different
  circles -- and the drill-in described a third. Worst at the 25m building tier,
  where 4dp (~11m) is a large fraction of the radius.

## status strings -- CONFIRMED against live API 2026-08-17

$select=status,count(*)&$group=status returns EIGHT values, not three:

    Closed 21,705,379 | In Progress 269,249 | Open 95,898 | Pending 63,068
    Assigned 24,412   | Started 5,318       | Unspecified 2,794 | Cancel 1

STATUS_TO_BUCKET in constants.js maps them onto the three the UI shows. The
buckets encode two questions at once -- is it resolved, and has anyone acted --
so Assigned/Started/Pending sit with In Progress, and Cancel with Closed.
Unspecified -> open, deliberately NOT in-progress: it carries no evidence anyone
acted, and claiming progress we cannot evidence is the worse error for someone
deciding on a lease. Unknown future values default the same way, so a ninth
value can never silently drop a row from a filtered list.

Do not re-derive these strings elsewhere -- import from constants.js, same rule
as complaint_type. The frontend's old mapStatus() was a second copy and had
already drifted, filing Assigned and Started under open.

GET /api/trend?lat=&lng=&tier=building|block&months=3|6|9|12|18|24
  returns: { tier, months, radiusMeters, points: [{ month: "YYYY-MM", count }], total }
  months defaults to 9. points is oldest-first and ZERO-FILLED — one entry per
  month in the window, always exactly `months` long.

  **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.**

  Why this exists rather than reusing /api/complaints: that endpoint returns
  individual records capped by `limit`, and on a dense block the most recent 200
  records span about two weeks. Bucketing them client-side drew a cliff that
  read as "complaints started recently" — measured, 350m around Ludlow St has
  10,903 complaints over 24 months, of which a 200-row page covers ~4 months at
  best. Here Socrata does the bucketing ($group on date_trunc_ym), so the
  response is one row per month whether the location has 12 complaints or
  12,000, and there is nothing to truncate.

  Cost: ~1.1KB and 25 rows vs ~1.7MB and 10,903 rows for the equivalent
  row-listing query. Latency is NOT the win — a cold within_circle query runs
  1-6s either way, since the spatial filter dominates, not the row count.
  That is why results are cached (see below); an uncached block-tier call was
  measured at 13s, which fits inside the Socrata retry budget but NOT inside a
  serverless function's execution cap.

  Cached in Mongo collection `trend_cache`, keyed {lat, lng, radiusTier, months}
  with the same 24h TTL as complaint_cache. Deliberately a SEPARATE collection:
  writeCounts() uses replaceOne, so a counts refresh would silently drop trends
  stored on that document, and unlike an explanation a trend is not invalidated
  by new counts. Measured 6.4s cold -> 3ms warm.

  The window set is closed, not an arbitrary integer: each value is its own
  cache key and its own upstream query, so an open parameter would let one
  caller spray 24 near-identical variants for no user benefit.

GET /api/showcase?limit=&mode=top|recent|random
  returns: { items: [ { address, borough, lat, lng, lookups, lastSeenAt,
                        curated, buildingHealth, blockQuality, meta }, ... ],
             fallback: { address, borough, lat, lng } }

  **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.**

  Addresses we have BOTH a name and cached scores for. Each item is the
  /api/score payload with the address grafted on, so the frontend needs no
  second type -- note `address` is a real string here, unlike on /api/score,
  where it is always null.

  CACHE-ONLY, and that is the contract, not an implementation detail: it never
  calls Socrata, so it cannot be slow and cannot 503. A cold or partly-expired
  cache yields FEWER items, or none; callers render what they get. Measured
  ~20-30ms warm against 8 addresses.

  Why it exists: the homepage used to fill its "sample report" card and its
  featured carousel with client-side generated scores -- a seeded PRNG dressed
  up as real addresses. For a product whose claim is "we only report what the
  city recorded" that was the one thing the landing page must not do. It now
  shows only real cached scores, and shows fewer (or a citywide-baseline panel)
  when there is nothing cached.

  Three modes, three sorts over the same rows: `top` by lookup count, `recent`
  by last lookup, `random` via $sample. Closed set -- each has an index behind
  it, and a free sort parameter would let a caller order the directory by an
  arbitrary field. limit is capped at 12.

  Requires the address directory below. A directory row whose counts have
  expired is skipped, which is the normal steady state (the directory has no
  TTL, the counts have a 24h one), so candidates are over-fetched 3x.

  `fallback` is one curated address (config/showcase.js) picked at RANDOM, with
  no scores attached, sent on every response whether or not items is empty. It
  exists so a caller with an empty list still has a real subject to show: the
  homepage's hero card fetches a live score for it client-side. Random, not
  pinned: the frontend used to hardcode 456 Park Ave for this, which made one
  building the permanent face of a cold homepage AND duplicated a committed list
  it could drift from. Any of the eight is equally real and equally pre-warmed.

POST /api/lookups   header: Authorization: Bearer $INTERNAL_API_SECRET
  body: { address: string, lat: number, lng: number }
  returns: 202 Accepted, empty body
           401 unauthorized          — wrong or missing bearer token
           503 lookups_not_configured — INTERNAL_API_SECRET unset

  **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.**

  Records that an address was looked up, so a cached coordinate can be NAMED
  later. Nothing else in the system stores address text.

  Deliberately NOT a field on POST /api/score. That endpoint's contract is
  coordinate-only with `address: null`, and this backend does not geocode --
  both stay true. The frontend fires this from the report view after the report
  is already on screen, so it costs the user nothing, and ignores the response.

  Stores the address, the ROUNDED coordinate (so the row joins complaint_cache),
  a lookup counter and timestamps. No caller identity, no session, no IP. The
  borough is derived server-side in lib/borough.js from the address text, with a
  coordinate bounding box as fallback -- never accepted from the caller.

  NOT CALLABLE FROM A BROWSER. This writes the one string the app stores and then
  SHOWS to other people, so "is this a real address?" is answered by WHERE IT
  CAME FROM, not by inspecting it. The Next.js geocode route resolves a Places
  suggestion the user picked, takes Google's own `formattedAddress` out of that
  response, and forwards it here server-to-server with the shared secret. A
  visitor cannot reach this endpoint, and the frontend never sends a string
  anyone typed.

  This replaced shape heuristics — house-number prefixes, TLD patterns, a "must
  name New York" rule. They were a blocklist by another name: each stopped only
  the phrasings someone had thought of, and the first cut let "BUY CRYPTO AT
  evil.example" through. Provenance has no such gap.

  `address` validation is now hygiene, not judgement: <= 200 chars and no control
  or bidi characters. It is STORED, never interpolated into a SoQL clause or a
  query predicate, so unlike `type` it needs no whitelist.

  Only the placeId path records. Free-text search still produces a report — it
  has to, or a direct link would break — but it carries no placeId, so nothing is
  written. The homepage is the one place provenance matters.

  202 rather than 201: this is fire-and-forget, and a directory write failing
  must not read as a failed report. Answers 202 even when Mongo is unconfigured
  and the write was skipped -- the caller has nothing to do differently.

GET /api/warm   header: Authorization: Bearer $CRON_SECRET
  returns: { warmed, failed, results: [{ address, ok, cache | error }] }
           401 unauthorized      — wrong or missing bearer token
           503 warm_not_configured — CRON_SECRET unset on this deployment

  **CONTRACT CHANGE (post-freeze): new endpoint. Flag to Person 2.**

  THE ONLY AUTHENTICATED ROUTE, and the only one that needs to be. Everything
  else here is a cheap read over public data; one call to this is ~62s of live
  Socrata queries against our app token's rate limit, so leaving it open means
  anyone who reads the network tab can hold the URL down and exhaust it.

  FAILS CLOSED: with CRON_SECRET unset it refuses everyone, cron included. The
  alternative — open when unconfigured, matching how every other env var here
  degrades — would make a forgotten variable a public expensive endpoint, which
  is the exact failure the secret exists to prevent. Nothing local depends on the
  route: `npm run warm:showcase` calls the service directly, no HTTP, no secret.

  Bearer, not a query parameter: query strings land in access logs, browser
  history and Referer headers. Compared with timingSafeEqual over SHA-256
  digests, so wrong guesses cost the same time and leak not even the length.

  The header format is Vercel's own convention — set CRON_SECRET in Project
  Settings and Vercel sends it on every scheduled invocation automatically.

  Fetches the curated showcase set (config/showcase.js, 8 addresses with
  committed real coordinates) from Socrata and caches it, so the homepage has
  real addresses to show on a cold cache. The ONE showcase path that goes
  upstream: sixteen Socrata calls, measured 62s. Keep it away from page loads.

  Hit by a daily Vercel cron (vercel.json) and by `npm run warm:showcase`. It
  re-fetches rather than checking first, deliberately: a cache HIT performs no
  write, so createdAt is untouched and the document still expires 24h after its
  last fetch. Only a write slides the TTL, which is what makes a daily cron
  effective.

  It no longer carries index creation on its back — see the Mongo section. It
  used to be the only path that built address_lookups' indexes in production,
  which quietly made warming load-bearing for something unrelated to warming.

GET /health
  returns: 200 OK   // for deploy checks + keep-warm pings

band = "good" | "fair" | "poor"

Every endpoint is public. This is a read-only view over NYC Open Data — there
is no per-caller state to protect, and nothing is written on a caller's behalf.
The one exception is POST /api/lookups, which writes a public address string and
a counter with nothing attached identifying who asked.

## Abuse surface — what is protected and why

Public does not mean free. Three things an anonymous caller could otherwise do,
without ever sending an invalid request, and what stops each:

1. **Put arbitrary text on the homepage.** POST /api/lookups writes the only
   caller-supplied string the app stores and then shows to other people (chips,
   carousel cards). React escapes it, so there is no script injection — the risk
   is defacement and spam.

   Solved by PROVENANCE, not inspection. The endpoint requires
   INTERNAL_API_SECRET and is called only by our Next.js geocode route, which
   forwards the `formattedAddress` Google returned for a Places suggestion the
   user picked. A stranger cannot write at all, and our own frontend never sends
   a string a visitor typed.

   An earlier version left the endpoint public and tried to TELL a real address
   from spam: house-number prefixes, domain patterns, a "must name New York"
   rule. It worked on the cases we imagined and let "BUY CRYPTO AT evil.example"
   through on the ones we did not — which is the permanent condition of a
   blocklist. Do not reintroduce that approach; if a new writer needs access,
   give it a credential.

   What remains in validateAddress is hygiene that holds regardless of source:
   a length bound, and control/bidi characters that would corrupt rendering.

2. **Burn upstream quota.** /api/score is two live Socrata queries on a miss and
   the caller picks the coordinate — the NYC bbox holds ~33M distinct cache keys
   at 4dp. /api/complaints?complete=1 was measured at 2.3-74.3s. /api/explanation
   spends a metered AI key. All rate limited per caller per minute, tiered by
   what the call COSTS us rather than by how it looks: see RATE_LIMIT_* in
   config/constants.js and lib/rateLimit.js.

3. **Run the warm job.** /api/warm is authenticated outright — see above.

Measured against real use: a person opening the homepage and three reports made
8 score, 10 complaints, 10 trend, 2 explanation and 3 lookups calls, all inside
limits of 60/60/60/30/30. The limits are clear of anything a human does and
immediate for anything a loop does.

**The limiter's honest weakness.** State is in-process memory, so on Vercel each
warm instance counts separately and the real ceiling is (instances x limit). A
shared counter in Mongo would add a write to every request on the same free-tier
cluster it is meant to protect, and would make the limiter a dependency of the
thing it defends. A hard global ceiling belongs at the edge (Vercel WAF /
Cloudflare), not here. Caller identity also leans on forwarding headers, which
are spoofable outside platforms that set them — x-vercel-forwarded-for and
x-real-ip are preferred over x-forwarded-for for that reason.

## Socrata query pattern

Two HTTP calls per uncached address (one per radius tier), NOT six or twelve.
Group by type within each radius call:

  $where  = within_circle(<LOCATION_FIELD>, lat, lng, radius)
            AND complaint_type in (...)
            AND created_date > '<cutoff>'
  $select = complaint_type, count(*)
  $group  = complaint_type
  $limit  = 50000

Then sum the returned per-string counts into their bucket (see weighting note above).

Client must set: app token header, ~5s timeout, retry-with-backoff on 429/5xx (max 2).

## Scoring

score(counts, baseline) is a PURE function.
1. Per bucket: convert summed count to percentile position vs baseline for that
   bucket + radius tier.
2. Aggregate three bucket percentiles into one sub-score (start: simple mean).
3. Map to band at fixed thresholds.

Baseline is computed ONCE by scripts/buildBaseline.js (sample ~few hundred spread
NYC coords, compute median + p90 per bucket per tier, write one baseline doc, commit
output). This is what makes the score defensible vs a raw count map. Do not skip.

Config constants (radii, time window, weights, thresholds) live in /config/constants.js.
Time window: start at trailing 24 months, tunable.

## Mongo

collection complaint_cache:
  { lat (rounded ~4dp), lng (rounded), radiusTier: "building"|"block",
    counts: {...six buckets...}, createdAt }
  - compound index {lat, lng, radiusTier}
  - TTL index on createdAt (~24h) for self-refresh
  - NO 2dsphere index. Spatial filtering is done by Socrata, not Mongo. Cache
    lookup is exact key match on rounded coords.

collection address_lookups:
  { address, borough, lat (rounded 4dp), lng (rounded), lookups, curated,
    firstSeenAt, lastSeenAt }
  - unique index {lat, lng} -- one row per cache coordinate, so a race between
    two first-lookups cannot split the counter across two documents
  - {lookups: -1, lastSeenAt: -1} and {lastSeenAt: -1} for the showcase sorts
  - **NO TTL index**, unlike the three caches. Those hold copies of city data
    that must expire; this holds the mapping needed to name a coordinate at all.
    If it expired with the counts there would be no way to re-warm an address or
    to label a cached score on the homepage.
  - Written by POST /api/lookups. The address text is $setOnInsert, so a
    coordinate keeps the FIRST name given to it -- "456 Park Ave" and "456 Park
    Avenue" round to one key, and letting the later win would make the homepage
    labels flicker. Curated seeds are inserted at lookups: 0 so real traffic
    always outranks them.

collection baseline:
  { _id: "v1", perBucket: { <bucket>: {median, p90} }, radiusTier, computedAt }
  - NO ensure*Indexes(), deliberately: every access is by _id, which Mongo
    indexes on every collection already. One document, nothing to sort or expire.

### Index creation: lazy and memoized, NOT from startup

Every collection above has a memoized `ensure*Indexes()` that its OWN provider
functions await before their first read or write. Do not add a collection whose
indexes are built only from `src/index.js`.

Why this is not a style preference: `src/index.js` assumes a long-running server
with a boot phase, and **Vercel has none**. `api/index.js` only builds the app,
and each request is its own short-lived invocation, so that file never executes
in production. Verified against a fresh database driven only through
`api/index.js`: complaint_cache, trend_cache and complaint_groups_cache came out
with NO indexes at all -- no unique constraint, and no TTL, meaning cached
documents would have lived forever instead of self-refreshing daily.
address_lookups escaped only because `/api/warm` built its indexes as a side
effect of doing something else.

Cost is one round trip per PROCESS, not per request: the memo means every later
call awaits an already-resolved promise (asserted in test/lazyIndexes.test.js).
A failed build is not memoized -- it resets, so the next call retries -- and it
never throws, because a missing index is a slower query, not a failed request.

`src/index.js` still builds them all at boot. That is now an optimisation for
the long-running paths (docker, `npm run dev`), moving the round trip off the
first request. Deleting it would cost latency; deleting the provider calls would
cost correctness.

## AI Explanation Layer (NEW SCOPE)

Each sub-score (Building Health, Block Quality) is accompanied by a 1-2 sentence
AI-generated explanation of why it got that band ("Good to live" / "Proceed with
caution" / etc). This is a separate step AFTER scoring, not inside the pure
score() function — scoring stays deterministic and fixture-tested; the AI call is
neither, and must be isolated so it can fail without breaking scoring.

**Two adapters, same interface, swapped by env var:**
- `ollama` — local dev only. Requires Ollama running locally with `llama3` pulled.
  Cannot run on Vercel (serverless has no persistent local process).
- `gemini` — deployed (Vercel) target. Hosted HTTP API, works identically in any
  environment including serverless.

Shared contract both adapters must implement:
`generateExplanation({ label, band, counts, radiusLabel }) -> Promise<string>`

```
/providers/ai
  index.js      factory: reads AI_PROVIDER env var, returns ollama.js or gemini.js
  ollama.js     calls http://localhost:11434/api/generate, model "llama3"
  gemini.js     calls generativelanguage.googleapis.com, model "gemini-2.5-flash-lite"
  prompt.js     buildPrompt() — SHARED by both adapters so output tone stays consistent
```

Prompt rules (baked into prompt.js, do not duplicate/diverge per adapter):
- Explicitly instruct: base explanation ONLY on the provided counts, do not invent
  addresses, dates, or specific incidents. This is the main defense against
  hallucinated specifics.
- temperature 0.3 (consistency over creativity), short output cap (~80-100 tokens).
- No mention of "percentile" or other technical scoring terms in the output.

**Env vars:**
- `AI_PROVIDER` = "ollama" (local `.env`) or "gemini" (Vercel dashboard)
- `GEMINI_API_KEY` = set in Vercel dashboard only, never committed

**Fallback is not optional.** services/explain.js wraps the adapter call in
try/catch; on ANY failure (timeout, rate limit, service down), fall back to
services/templateExplanation.js, a deterministic template keyed by band + dominant
bucket. Demo must never show a broken/error state for this feature.

**Caching:** explanation is generated once and stored on the SAME complaint_cache
Mongo document as the score (same TTL), not regenerated per request. This matters
more for Ollama (slow on CPU) but keep it for Gemini too, to stay under free-tier
daily request caps.

**Two-call pattern (see API contract for exact shapes):** POST /api/score never
blocks on the AI call — on a cache miss it returns the deterministic template
explanation immediately with explanationSource: "template". Frontend then fires
GET /api/explanation as a second call ONLY when it sees "template", which does
the actual AI generation, writes it to the same cache doc, and returns the real
text for the frontend to swap in. Synchronous, no polling — deliberate hackathon
simplification. This is what actually solves the Vercel timeout risk: the slow
AI call is now its own request with its own budget, not stacked behind the
Socrata + scoring latency on the main score request.

**Model deprecation flag:** gemini-2.5-flash and gemini-2.5-flash-lite are
scheduled to shut down Oct 16, 2026 per Google's notice. Fine for the hackathon
timeline, but if this project continues past that date, swap the model string —
it lives in ONE place (constants.js), not hardcoded in gemini.js directly, so
confirm that's actually how it's wired before relying on it.

**Tone-consistency check:** Llama 3 8B and Gemini Flash-Lite are different models
and may not produce similarly-toned output from an identical prompt. Before
demo day, run both adapters against the same cached counts and eyeball the two
outputs side by side. If they diverge noticeably, tighten prompt.js (more explicit
tone/length constraints) rather than shipping two different-feeling products
depending on environment.

## Deployment (Vercel)

- Express app must be adapted for serverless, not run as-is with app.listen().
  **DONE** — `api/index.js` exports `createApp()`'s app instance directly.
  Vercel's Node.js runtime calls functions with plain `(req, res)`, the same
  signature an Express app already implements as an http.Server request
  listener, so no adapter is needed. (`serverless-http` was tried first — it
  targets AWS Lambda's event/context convention, which Vercel's Node.js
  functions don't use, and it 500'd on every request in practice.)
- Indexes MUST be created lazily from the provider functions, never from
  `src/index.js` — that file does not run on Vercel. See "Index creation" under
  Mongo above. **DONE** — every collection has a memoized `ensure*Indexes()`
  awaited by its own reads and writes.
- Mongo connections MUST be cached on `global`, not opened fresh per invocation,
  or you'll exhaust Atlas's connection limit under any real traffic.
  **DONE** — `providers/mongo.js` caches the client and its connect promise on a
  `Symbol.for()`-keyed slot on `globalThis`, which survives module-registry
  rebuilds (serverless instance reuse, `node --watch`) the way a module-scoped
  memo does not. Pool is bounded at 10 (`MONGO_MAX_POOL_SIZE`) against the M0
  500-connection cap. Covered by `test/mongo.test.js`.
- Dev and prod use different databases: local Docker mongod
  (`nyc-streetwise-dev`) vs Atlas (`nyc-streetwise`). No code branches on this —
  only `MONGODB_URI` / `MONGODB_DB` differ. Prod values are recorded in
  `.env.production.example` for pasting into the host's env settings.
- Env vars (SOCRATA_APP_TOKEN, MONGODB_URI, AI_PROVIDER, GEMINI_API_KEY,
  CRON_SECRET) go in Vercel dashboard > Project Settings. .env files do NOT
  deploy. All of them are optional in the sense that a missing one degrades the
  deploy (uncached, throttled, or template-only explanations) rather than failing
  it — **except CRON_SECRET**, which fails closed: unset, GET /api/warm answers
  503 and the daily cron warms nothing, so the homepage's curated addresses fall
  out of the 24h cache. That asymmetry is deliberate; see the endpoint above.
- Hobby tier function execution cap (reportedly ~10s) — verify actual current
  limit on Vercel's own pricing page before assuming. This is another reason the
  AI explanation call happens at cache-write time, not inline in the live request
  path when deployed.
- Ollama-based local dev and Gemini-based deployed behavior are expected to
  differ in this one respect: this is intentional, not a bug, per adapter design
  above.

## Repo shape

/src
  /routes      score.js, complaints.js, health.js, explanation.js, trend.js
  /services    scoreService.js, scoring.js (pure), explain.js, templateExplanation.js,
               mockData.js
  /providers   socrata.js, cache.js, mongo.js, baseline.js
    /ai        index.js, ollama.js, gemini.js, prompt.js
  /lib         validate.js
  /config      constants.js
/scripts       buildBaseline.js, verify*.js
/test          scoring.test.js, routes.test.js, cache.test.js, ...
api/index.js   Vercel serverless entrypoint (wraps Express app)

## OPEN ITEMS — verify against live API before building on top

1. ~~Exact complaint_type strings~~ — RESOLVED, see table above.
2. Exact geolocation column name for within_circle (the geo-typed column, not the
   separate latitude/longitude text fields). Check via a single-row pull:
   `erm2-nwe9.json?$limit=1` and inspect field types on the dataset's About page.
3. ~~Null-geocoding rate PER bucket~~ — RESOLVED for the Building Health buckets.
   Measured against live `erm2-nwe9` over the trailing 24 months, counting
   `location IS NOT NULL` (the geo column `within_circle` actually uses):

   | complaint_type | total | geocoded | missing |
   |---|---|---|---|
   | HEAT/HOT WATER | 651,313 | 651,263 | 50 (0.008%) |
   | UNSANITARY CONDITION | 247,974 | 247,954 | 20 (0.008%) |
   | PLUMBING | 149,848 | 149,835 | 13 (0.009%) |

   The concern that plumbing/unsanitary would be spottier than noise/parking is
   NOT borne out — all three are >99.99% geocoded. No fallback to
   `incident_address` is needed. **Block Quality buckets still unmeasured.**

   Consequence worth knowing: zero building counts are therefore REAL data, not
   a geocoding artifact. At a 25m radius, 9 of 10 sampled NYC coordinates had
   zero building complaints — citywide there are only ~0.65 heat complaints per
   building over 24 months. This is what makes the Building Health explanation
   land on the template path at nearly every address (see explain.js's
   deliberate zero-complaint short-circuit), and it is the strongest argument
   for revisiting the 25m radius in open item 5.
4. Dataset title has changed over time on the Socrata page (same UID). Confirm
   current title + date range on the dataset page.
5. Tight building radius may bleed into adjacent buildings on dense blocks. Person 3
   owns radius testing; coordinate before trusting building scores.
6. Gemini free-tier RPM/RPD caps — figures used in planning came from third-party
   reporting, not confirmed directly against ai.google.dev/gemini-api/docs/pricing.
   Check that page directly before assuming the exact numbers.

## Build order

P0: Express skeleton + MOCKED /api/score in frozen shape, deployed. Unblocks team.
P1: Socrata client + null-geocoding check (item 3). Item 1 already resolved above.
P2: real getCounts (with bucket-level summing) + cache read/write + TTL.
P3: buildBaseline.js, then score() against it.
P3.5: AI explanation layer — both adapters, factory, template fallback, GET
    /api/explanation endpoint as the separate slow-path call (see AI
    Explanation Layer and API contract sections above).
P4: swap mock for real, integrate. Budget full time; clean integration is rare.
P5: pre-warm cache for demo addresses (score + explanation both); serve cached
    value on live-API/AI failure; keep backend warm (free tiers cold-start and
    look broken mid-demo).

## Conventions

- Live-proxy + cache. NOT bulk ingest (millions of rows would blow free Atlas tier).
- Validate coords in NYC bounds (~lat 40.4-40.95, lng -74.3 to -73.7); 400 on bad input.
- Do not put personal data or coordinates in logs beyond what debugging needs.
- AI adapters are provider-agnostic at the call site (services/explain.js). Never
  branch on AI_PROVIDER outside providers/ai/index.js.