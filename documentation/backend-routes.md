# Backend — Routes (`backend/src/routes/`)

Nine route modules, each mounted directly onto the Express app in
`src/app.js`. All request validation lives in `src/lib/validate.js`; all
per-caller throttling goes through `src/lib/rateLimit.js`
(see [`backend-config-and-scripts.md`](./backend-config-and-scripts.md#rate-limits)
for the tiers). Providers these routes sit on top of are in
[`backend-providers.md`](./backend-providers.md); the full request/response
contract with real captured samples lives in `backend/CLAUDE.md`.

---

## `POST /api/score` — `score.js`

The main endpoint. One coordinate in, the whole report out: two complaint-based
scores (Building Health, Block Quality) plus up to four amenity-based scores
(Transit, Parks, Bike, Walkability Access) and a whole-report summary.
Rate limited under `RATE_LIMIT_UPSTREAM` (60/min) — a miss is two live Socrata
queries plus whatever amenity lookups apply.

**Request body:** `{ "lat": 40.698, "lng": -73.921 }` — both required, numbers
or numeric strings, must fall inside `NYC_BOUNDS`. Out-of-bounds is
`400 out_of_bounds`.

**Response shape** (frozen core; new sections are additive — see `backend/CLAUDE.md`
for the full field-by-field contract and every additive change made to it):

```jsonc
{
  "address": null,                         // this API never geocodes
  "summary": { "explanation": string, "explanationSource": "ai" | "template" },
  "buildingHealth": {
    "score": 0-100, "band": "good"|"fair"|"poor",
    "counts": { "heatHotWater", "unsanitaryCondition", "plumbing" },
    "radiusMeters": 25, "confidence", "confidenceReason",
    "bucketScores": {...}, "bucketConfidence": {...},
    "explanation": string, "explanationSource": "template",  // always template here
    "bucketStatusCounts"?: { <bucket>: { open, "in-progress", closed } }
  },
  "blockQuality": { /* same shape, buckets: noise, parking, streetCondition, radiusMeters: 350 */ },

  // Present only when its own dataset/lookup succeeded — a failure omits the
  // key rather than scoring the tier as if nothing were nearby.
  "transitAccess"?: {
    "score", "band", "metrics": { "subway", "bus", "rail" },
    "radiusMeters": 800, "confidence", "confidenceReason",
    "bucketScores", "bucketConfidence"
    // no explanation field — the frontend renders its own "Why this score?"
  },
  "parksAccess"?: { "...same shape", "metrics": { "park", "playground", "garden" } },
  "bikeAccess"?: { "...same shape", "metrics": { "bikeShare", "bikeLane", "protectedLane" } },
  "walkabilityAccess"?: { "...same shape", "metrics": { "grocery", "restaurant", "cafe", "school" } },
  // each metric: { meters: number|null, within: number, name: string|null, routes: string[] }
  // meters caps at AMENITY_MAX_METERS (null past it); within is display-only,
  // never scored; routes is populated only on transit.subway / transit.bus.

  "meta": {
    "windowMonths": 24, "baselineVersion": "v1", "baselineSource": "mongo"|"file"|"mock",
    "coord": { "lat", "lng" },              // the ROUNDED coordinate actually queried
    "cache": { "building": "hit"|"miss", "block": "hit"|"miss" }
  }
}
```

**Always fast.** None of the six sections ever blocks on an AI call —
`buildingHealth`/`blockQuality`'s `explanation` is the deterministic template,
computed inline. The three static amenity tiers are a free in-memory grid
lookup issued alongside the complaint counts. `walkabilityAccess` is the one
exception: on a coordinate not already in its cache, this endpoint makes a
live, billed Google Places call (~4s timeout) before responding.

Delegates entirely to `services/scoreService.js#buildScoreReport()`. On
upstream (Socrata) failure: `503 upstream_unavailable`.

---

## `GET /api/explanation` — `explanation.js`

The slow path, and the **only** call in the app that ever hits an AI model.

```
GET /api/explanation?lat=&lng=&tier=overall
→ { explanation: string, explanationSource: "ai" | "template" }
```

`tier` accepts only `overall` — every per-section explanation
(building/block/transit/parks/bike/walkability) is deterministic and already
attached directly on `POST /api/score`. This endpoint exists only for the
one whole-report `summary` field, because generating it with a real model
takes seconds and must not sit on `POST /api/score`'s critical path.

Call this **only** when `/api/score`'s `summary.explanationSource` came back
`"template"`. Synchronous — no polling. Rate limited under `RATE_LIMIT_AI`
(30/min, tighter than the Socrata tiers because it spends a metered AI key).

---

## `GET /api/complaints` — `complaints.js`

Individual complaint records — built for a map/heatmap view and the
complaints browser, **never** for computing totals (all counts come from
`/api/score`, which aggregates server-side over the full window).

**Query params:** `lat`, `lng` (required), `radius` (meters, default the
tier's own radius, capped at 2000), `limit` (default 1000 raw / 25 grouped,
max 5000), `tier` (`building` | `block`, restricts to that tier's types),
`complete` (`1` switches to grouped mode).

**Default mode** — bare array, newest first:
```jsonc
[{ "unique_key", "type", "lat", "lng", "created_date", "status" }, ...]
```
Headers: `X-Complaints-Truncated`, `X-Complaints-Limit`.

**Grouped mode** (`complete=1`) — one row per `(day, complaint_type)` with a
status breakdown, for the complaints browser. Extra params: `months`
(3|6|9|12|18|24, default 24), `bucket`, `status`, `offset`.
```jsonc
[{ "day": "2026-08-14", "type": "Noise - Residential",
   "counts": { "open": 3, "in-progress": 0, "closed": 7 }, "total": 10 }]
```
Headers: `X-Complaints-Total` (matching **groups**, not complaints, before
paging), `X-Complaints-Offset`, `X-Complaints-Has-More`, `X-Complaints-Cached`.

Rate limited under `RATE_LIMIT_UPSTREAM` in default mode, `RATE_LIMIT_FILL`
(10/min) for `complete=1` — the first grouped request for an address fills a
24h cache and was measured at 2.3–74.3s.

## `GET /api/complaints/group` — `complaints.js`

The individual complaints behind one `(day, type)` row of the grouped
browser. **Paginated**, not merely capped — the largest single group measured
is 4,978 rows.

**Query params:** `lat`, `lng`, `tier` (supplies the radius), `type`
(a known `complaint_type`), `day` (`YYYY-MM-DD`), `status`, `offset`, `limit`
(default 50, max 5000). Live and uncached — the cost is the spatial filter,
not the row count, so a day+type cache would buy little.

---

## `GET /api/trend` — `trend.js`

```
GET /api/trend?lat=&lng=&tier=building|block&months=3|6|9|12|18|24
→ { tier, months, radiusMeters, points: [{ month: "YYYY-MM", count }], total }
```

`months` defaults to `TREND_DEFAULT_MONTHS` (9). `points` is oldest-first and
zero-filled — always exactly `months` entries. Exists because `/api/complaints`
cannot answer this honestly: its row cap means a dense block's most recent
page spans only a couple of weeks, so bucketing it client-side draws a false
cliff. Here Socrata does the bucketing server-side (`$group` on
`date_trunc_ym`), so the response is one row per month regardless of density.

Cached in its own `trend_cache` collection (24h TTL) — deliberately separate
from `complaint_cache` because a counts refresh (`writeCounts`'s `replaceOne`)
would otherwise silently drop the trend alongside it. Rate limited under
`RATE_LIMIT_UPSTREAM`.

---

## `GET /api/showcase` — `showcase.js`

```
GET /api/showcase?limit=1-12(default 6)&mode=top|recent|random
→ { items: [ /* POST /api/score payload + address */, ... ],
    fallback: { address, borough, lat, lng } }
```

Addresses the backend has **both** a name and cached scores for — what backs
the homepage's live report card, "Try:" chips, and recently-checked carousel.
Each item is the `/api/score` payload with a real `address` string grafted on
(unlike `/api/score` itself, where `address` is always `null`).

**Cache-only, by contract** — never calls Socrata, so it cannot be slow and
cannot 503. A cold or partly-expired cache just returns fewer items. `fallback`
is one curated address (`config/showcase.js`) picked at random on every call,
present even when `items` is empty, so there is always something real to show.
Rate limited under `RATE_LIMIT_READ` (240/min — cheap Mongo reads).

## `POST /api/lookups` — `showcase.js`

```
POST /api/lookups   header: Authorization: Bearer $INTERNAL_API_SECRET
body: { address, lat, lng } → 202 Accepted (empty body)
```

Records that an address was looked up, so a cached coordinate can be **named**
on the showcase later — nothing else in the system stores address text.
**Not callable from a browser.** Requires the shared secret and is called
only by the frontend's own `geocode` route, server-to-server, forwarding
Google's own `formattedAddress` for a Places suggestion the user picked — so
the string's trustworthiness comes from its provenance, not from inspecting
its shape. `401 unauthorized` without the token, `503 lookups_not_configured`
if `INTERNAL_API_SECRET` is unset. Rate limited under `RATE_LIMIT_INTERNAL`
(600/min — every legitimate call comes from one caller, so this is a circuit
breaker, not per-visitor fairness).

## `GET /api/warm` — `showcase.js`

```
GET /api/warm   header: Authorization: Bearer $CRON_SECRET
→ { warmed, failed, results: [{ address, ok, cache | error }] }
```

Fetches the curated showcase set (`config/showcase.js`, 8 addresses) from
Socrata and caches it, so the homepage has real addresses on a cold cache.
**The only authenticated route**, and the only one that needs to be — one
call is sixteen live Socrata queries, ~62s. Fails closed: `CRON_SECRET` unset
means `503 warm_not_configured` for everyone, cron included. Hit by a daily
Vercel cron (`vercel.json`) and by `npm run warm:showcase` locally (bypasses
HTTP entirely).

---

## Amenities — `amenities.js`

### `GET /api/amenities/nearby?lat=&lng=&tier=&bucket=`

```
→ { instances: [{ name, meters, lat, lng, routes?, entrances? }],
    radiusMeters, truncated: boolean }
```

Every real instance of one bucket within its tier's radius — not just the
single nearest point `POST /api/score` reports. Backs the amenity panel's
"see all N within 800m" affordance. `tier` is any `AMENITY_TIERS` key
(transit/parks/bike/walkability); `bucket` must belong to that tier.

For transit/parks/bike this is a **pure in-memory grid lookup** — no Socrata,
no Mongo, no external call — so it is rate limited under the cheap
`RATE_LIMIT_READ` tier. Capped at `limit` (default 50). `subway` and `bus`
get extra clustering: subway entrances are grouped into one row per station
**complex** (MTA's own `complex_id`, with a 1km outlier guard against a small
number of mislabeled rows — see `backend/CLAUDE.md`), capped at 5 complexes;
bus stops are already one point per physical pole from build-time clustering,
capped at 5 poles. `bikeLane`/`protectedLane` return `400 bucket_not_applicable`
— those are a resampled route **line**, not discrete places, so "every
instance within radius" is unrepresentable for them by design
(`NON_DISCRETE_AMENITY_BUCKETS`).

**Walkability is the one exception to "pure in-memory."** It has no
preloaded spatial index, so a separate function serves it, **cache-only** —
it reads whatever Places result `POST /api/score` already cached for this
exact coordinate and never issues a live Places call itself.

### `GET /api/refresh-amenities` — header: `Authorization: Bearer $CRON_SECRET`

```
→ { saved: boolean, bikeShareStations: number, refreshedAt: string }
```

The monthly amenity-data refresh — scoped to the **bike-share** bucket alone,
because Citi Bike docks genuinely open/close monthly while subway entrances,
park boundaries, and DOT bike-lane geometry change on a scale of years.
Same auth pattern and fails-closed reasoning as `/api/warm`. `saved: false`
means the fetch succeeded but the write was refused by a >30%-drop sanity
guard (a truncated GBFS response degrades to "kept last month's data").
Hit by a monthly Vercel cron (`0 6 1 * *`).

---

## `GET /health` — `health.js`

```json
{ "status": "ok", "uptimeSeconds": 1234 }
```

Deliberately dependency-free — must return `200` even with Mongo and Socrata
both down, or a host's deploy/keep-warm check would recycle the instance for
the wrong reason. Not rate limited.

---

## Error handling

All routes rely on the central error middleware in `src/app.js`:

| Thrown as | HTTP status | Body |
|---|---|---|
| `BadRequestError` (`lib/validate.js`) | 400 | `{ error, details }` |
| `SocrataError` (upstream failure after retries) | 503 | `{ error: "upstream_unavailable", details }` |
| rate limit exceeded (`lib/rateLimit.js`) | 429 | `{ error: "rate_limited", details }`, `Retry-After` + `X-RateLimit-*` headers |
| anything else | 500 | `{ error: "internal_error" }` (no internals leaked) |

Unmatched routes return `404 { "error": "not_found" }`. `SocrataError` is
dispatched on error *type*, never a bare `.status` number — `SocrataError`
carries the **upstream's** status, which would otherwise collide with a
generic "4xx means client error" branch.
