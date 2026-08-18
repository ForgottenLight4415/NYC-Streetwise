# API reference — "Should I Live Here"

Backend for the NYC 311 address risk tool. Takes a coordinate, returns two
0–100 scores derived from live NYC 311 complaint data.

- **Base URL (local):** `http://localhost:3001`
- **Auth:** none, on every endpoint but one. This is a read-only view over NYC
  Open Data and nothing here belongs to any one caller. Two exceptions worth
  knowing: `POST /api/lookups` appends a public address string and a counter
  (with nothing identifying who asked), and `GET /api/warm` requires a bearer
  token because it is the only call that costs real upstream work.
- **Rate limits:** per caller per minute, tiered by what a call costs to serve —
  60 for Socrata-backed reads (`/api/score`, `/api/trend`, `/api/complaints`),
  30 for `/api/explanation` (metered AI key), 10 for
  the grouped fill (`/api/complaints?complete=1`, measured 2.3–74.3s), 240 for
  cache-only reads. Over the line is `429 rate_limited` with `Retry-After` and
  `X-RateLimit-*` headers. Ordinary use does not come close: opening the homepage
  and three reports costs 8 / 10 / 10 / 2 / 3 against those budgets.
- **Content type:** `application/json` everywhere.
- **CORS:** open (`Access-Control-Allow-Origin: *`), preflight answered with 204.

All samples below are real responses captured from a running server, not
illustrations.

---

## Three things to know before integrating

**1. This API does not geocode.** It takes `{lat, lng}` and never converts an
address. The frontend gets coordinates from Google Places Autocomplete and sends
those. Send **rooftop-precision** coordinates — a street-interpolated or
mid-block coordinate finds no building complaints and scores as a *perfect*
building. The response flags this (see `confidenceReason: "no_complaints_found"`),
but the flag is a safety net, not a fix.

**2. Never count from `/api/complaints`.** It returns the most recent N points
and truncates on dense blocks. All counts come from `/api/score`, which
aggregates server-side over the full window.

**3. Explanations arrive in two calls.** `/api/score` is always fast and may
return a template explanation. If it does, call `/api/explanation` to get the
AI-written one and swap it in place. See [Explanations](#explanations) below.

---

## Explanations

Every sub-score carries a 1–2 sentence plain-English `explanation` and an
`explanationSource` saying where it came from.

| `explanationSource` | Meaning |
| --- | --- |
| `"template"` | Deterministic text generated server-side with no AI. Always instant. |
| `"ai"` | Written by a language model from the same complaint counts. |

`/api/score` **never waits on the AI**. On a cache miss it returns the template
immediately; the AI version is produced by a second call.

### The two-call flow

```
1. POST /api/score                      → explanationSource: "template"
2. GET  /api/explanation?...&tier=...   → explanationSource: "ai"
3. swap the text in place
```

A real round trip against one Harlem coordinate, captured in that order:

```bash
$ curl -X POST localhost:3001/api/score -H 'Content-Type: application/json' \
    -d '{"lat":40.8116,"lng":-73.9465}'
  buildingHealth.explanation      "Fewer 311 complaints here than in most of the city
                                   for this building. Plumbing stands out with 5
                                   complaints in the last 24 months, out of 17 total."
  buildingHealth.explanationSource "template"          ← needs upgrading

$ curl "localhost:3001/api/explanation?lat=40.8116&lng=-73.9465&tier=building"
  explanation                     "Residents in this building can expect a relatively
                                   quiet maintenance record, having accumulated only 6
                                   heat and hot water, 6 unsanitary conditions, and 5
                                   plumbing issues over the past 24 months. …"
  explanationSource               "ai"                 ← swap this in

$ curl -X POST localhost:3001/api/score …   # same coordinate, later
  buildingHealth.explanationSource "ai"                ← now cached; skip step 2
```

Skip step 2 for any sub-score where `/api/score` already returned `"ai"` — that
means the explanation was cached from an earlier visit and there is nothing to
upgrade.

```js
const report = await getScore(lat, lng);
render(report); // template text shows immediately — never block on step 2

for (const [tier, key] of [["building", "buildingHealth"], ["block", "blockQuality"]]) {
  if (report[key].explanationSource === "ai") continue; // already the real thing

  fetch(`${BASE}/api/explanation?lat=${lat}&lng=${lng}&tier=${tier}`)
    .then((res) => res.json())
    .then(({ explanation, explanationSource }) => {
      if (explanationSource === "ai") swapExplanation(key, explanation);
    })
    .catch(() => {}); // template text stays; nothing to show the user
}
```

Never block rendering on step 2. If `/api/explanation` never resolves, the
template text is already on screen and remains correct.

The two calls are technically independent, but firing them in parallel is
slower, not faster: `/api/explanation` needs the same complaint counts, so
starting it before `/api/score` has populated the cache makes it fetch them
again. Chaining costs nothing visible — the template renders off call 1 either
way. See [Latency](#latency-1) under that endpoint.

Explanations are generated from the complaint counts only. They cannot reference
a specific incident, address, date, or landlord, because the model is never
given any.

---

## `POST /api/score`

The main endpoint. Returns Building Health and Block Quality for one coordinate.

### Request

```jsonc
{
  "lat": 40.698,   // required, 40.4 – 40.95
  "lng": -73.921   // required, -74.3 – -73.7
}
```

Both fields accept numbers or numeric strings. Coordinates outside the NYC
bounding box are rejected with `400 out_of_bounds`.

### Sample request

```bash
curl -X POST http://localhost:3001/api/score \
  -H 'Content-Type: application/json' \
  -d '{"lat": 40.698, "lng": -73.921}'
```

```js
const res = await fetch("http://localhost:3001/api/score", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lat: 40.698, lng: -73.921 }),
});
if (!res.ok) throw new Error((await res.json()).error);
const report = await res.json();
```

### Sample response — `200 OK`

Bushwick, Brooklyn. A well-maintained building on a loud block:

```json
{
  "address": null,
  "buildingHealth": {
    "score": 91,
    "band": "good",
    "counts": {
      "heatHotWater": 5,
      "unsanitaryCondition": 0,
      "plumbing": 1
    },
    "radiusMeters": 25,
    "confidence": "normal",
    "confidenceReason": null,
    "bucketScores": {
      "heatHotWater": 88,
      "unsanitaryCondition": 100,
      "plumbing": 86
    },
    "bucketConfidence": {},
    "explanation": "There have been 5 complaints about heat and hot water issues in this building over the past 24 months, which is a notable number given that there were no unsanitary conditions reported. Additionally, only 1 complaint was filed regarding plumbing issues, indicating relatively low numbers of problems with these basic services.",
    "explanationSource": "ai"
  },
  "blockQuality": {
    "score": 36,
    "band": "poor",
    "counts": {
      "noise": 2876,
      "parking": 1253,
      "streetCondition": 144
    },
    "radiusMeters": 350,
    "confidence": "normal",
    "confidenceReason": null,
    "bucketScores": {
      "noise": 18,
      "parking": 46,
      "streetCondition": 44
    },
    "bucketConfidence": {
      "streetCondition": "low"
    },
    "explanation": "As a resident here, you can expect to hear a lot of noise complaints and witness frequent issues with illegal parking and blocked driveways. Noise complaints account for 2876 of the total complaints filed in the last 24 months, while street and sidewalk conditions are relatively low at 144 complaints.",
    "explanationSource": "ai"
  },
  "meta": {
    "windowMonths": 24,
    "baselineVersion": "v1",
    "baselineSource": "mongo",
    "coord": { "lat": 40.698, "lng": -73.921 },
    "cache": { "building": "hit", "block": "hit" }
  }
}
```

### Field reference

| Field | Type | Meaning |
| --- | --- | --- |
| `address` | `null` | Always null. We do not geocode. |
| `buildingHealth` | object | 25m radius: heat/hot water, unsanitary condition, plumbing |
| `blockQuality` | object | 350m radius: noise, parking, street condition |
| `meta` | object | Non-scoring context; safe to ignore |

Each sub-score object:

| Field | Type | Meaning |
| --- | --- | --- |
| `score` | `0–100` int | **100 = fewest complaints = best.** Mind the direction. |
| `band` | `"good"` \| `"fair"` \| `"poor"` | `good ≥ 70`, `fair ≥ 40`, else `poor` |
| `counts` | `{bucket: int}` | Raw complaint counts over the trailing 24 months |
| `radiusMeters` | int | The circle these counts came from (25 or 350) |
| `confidence` | `"normal"` \| `"low"` | Whether to trust this sub-score |
| `confidenceReason` | string \| `null` | Why it is low; `null` when normal |
| `bucketScores` | `{bucket: 0–100}` | Per-bucket score, same direction as `score` |
| `bucketConfidence` | `{bucket: "low"}` | **Only lists non-normal buckets.** `{}` means all solid. |
| `explanation` | string | 1–2 sentences in plain English. Never empty. |
| `explanationSource` | `"ai"` \| `"template"` | `"template"` means the AI version is available from `/api/explanation` |

`meta`:

| Field | Meaning |
| --- | --- |
| `windowMonths` | Trailing window the counts cover (24) |
| `baselineVersion` | Which citywide baseline scored this (`"v1"`; `"mock"` in mock mode) |
| `baselineSource` | `"mongo"`, `"file"`, or `"mock"` |
| `coord` | The **rounded** coordinate actually queried (~11m from what you sent). Omitted in mock mode. |
| `cache` | `"hit"` or `"miss"` per tier — `"hit"` responses are ~2ms. Omitted in mock mode. |
| `mock` | Present and `true` only in mock mode |

### How the score is computed

A raw count means nothing to a renter — "47 noise complaints" is not
interpretable. Each count is placed against a **citywide baseline** built from
~250 sampled NYC locations per tier, then inverted:

| Your count is… | Score |
| --- | --- |
| zero | 100 |
| at the citywide median | 50 |
| at the citywide p90 | 10 |
| far above p90 | 0 |

The three bucket scores are averaged into the sub-score. So `blockQuality: 36`
means *this block is worse than a typical NYC block*, not "36 complaints".

### Confidence

Show the score, but qualify it when `confidence` is `"low"`:

| `confidenceReason` | What happened | Suggested UI |
| --- | --- | --- |
| `no_complaints_found` | Every bucket returned 0 | "No records found at this location — this may not be a building address." **Do not present as good news.** |
| `no_baseline` | No citywide baseline available | "Score is not comparable to the rest of the city." |
| `stale_baseline_radius` | Baseline was built at a different radius | Backend misconfiguration — surface to the team, not the user |

`bucketConfidence` is separate and per-bucket. Today it always contains
`streetCondition: "low"`: 25.6% of Street Condition records have no coordinates,
and the missing rate varies by borough (19% Manhattan → 31% Queens), so that
bucket is weaker than the other five. De-emphasize it visually rather than
presenting it as equally solid.

### Sample response — low confidence

A mid-street coordinate. Note the score is 100 and the confidence is `low` — this
is the failure mode the flag exists for:

```json
{
  "score": 100,
  "band": "good",
  "counts": {
    "heatHotWater": 0,
    "unsanitaryCondition": 0,
    "plumbing": 0
  },
  "radiusMeters": 25,
  "confidence": "low",
  "confidenceReason": "no_complaints_found",
  "bucketScores": {
    "heatHotWater": 100,
    "unsanitaryCondition": 100,
    "plumbing": 100
  },
  "bucketConfidence": {}
}
```

### Latency

| Case | Time |
| --- | --- |
| Cached (`meta.cache` all `"hit"`) | ~2–5ms |
| Uncached | 0.3–2.5s (two upstream calls) |
| Uncached, upstream slow | up to ~8s (observed) |

The tail is real: NYC Open Data occasionally takes seconds to answer and the
client retries with backoff on top. An 8.3s cold response was measured on
2026-08-15. That sits uncomfortably close to Vercel's function cap, and it is
the reason the AI call was moved out of this request. Pre-warm any address you
intend to demo — cache entries live 24h.

---

## `GET /api/complaints`

Individual complaint points for the heatmap.

### Query parameters

| Param | Required | Default | Notes |
| --- | --- | --- | --- |
| `lat` | yes | — | Must be inside NYC bounds |
| `lng` | yes | — | Must be inside NYC bounds |
| `radius` | no | `350` | Meters, 1–2000 |
| `limit` | no | `1000` (raw) / `25` (grouped) | Whole number, 1–5000 |
| `tier` | no | both tiers | `building` or `block`. Restricts to that tier's complaint types |
| `complete` | no | off | `1` switches to grouped mode (see below) |

Grouped mode (`complete=1`) accepts four more:

| Param | Required | Default | Notes |
| --- | --- | --- | --- |
| `months` | no | `24` | One of 3, 6, 9, 12, 18, 24 |
| `bucket` | no | all | A bucket of the given `tier`; requires `tier` |
| `status` | no | all | `open`, `in-progress` or `closed` — our bucket, never a raw 311 status |
| `offset` | no | `0` | Whole number, 0–10000 |

### Sample request

```bash
curl -i "http://localhost:3001/api/complaints?lat=40.698&lng=-73.921&radius=350&limit=3"
```

### Sample response — `200 OK`

```
X-Complaints-Truncated: true
X-Complaints-Limit: 3
```

```json
[
  {
    "type": "Sidewalk Condition",
    "lat": 40.69878996018205,
    "lng": -73.9184379499003,
    "created_date": "2026-08-14T00:21:33.000",
    "status": "In Progress"
  },
  {
    "type": "Noise - Street/Sidewalk",
    "lat": 40.697266756427595,
    "lng": -73.922619521571,
    "created_date": "2026-08-13T21:46:38.000",
    "status": "Closed"
  },
  {
    "type": "Noise - Commercial",
    "lat": 40.69805399996578,
    "lng": -73.92187209378284,
    "created_date": "2026-08-13T21:12:11.000",
    "status": "Closed"
  }
]
```

`status` may be `null`. `type` is the raw 311 `complaint_type` string.
`statusBucket` is that status mapped onto `open` / `in-progress` / `closed` —
read this rather than re-deriving it, because the dataset returns eight distinct
status values, not three (see `STATUS_TO_BUCKET` in `constants.js`).

### Grouped mode — `complete=1`

Returns one row per `(day, complaint_type)` with a status breakdown, newest day
first, for the complaints browser:

```json
[
  { "day": "2026-08-14",
    "type": "Noise - Residential",
    "counts": { "open": 3, "in-progress": 0, "closed": 7 },
    "total": 10 }
]
```

```
X-Complaints-Total: 2929      <- GROUPS matching the filters, before paging
X-Complaints-Offset: 0
X-Complaints-Has-More: true
X-Complaints-Cached: true
```

**`X-Complaints-Total` counts groups, not complaints.** Paging is over groups
too, so `offset=25` skips 25 `(day, type)` rows, not 25 complaints.

The first grouped request for an address fills a 24h cache and was measured at
**2.3–74.3s**; every request after it is a Mongo read. Do not put this on a page
load — that is why it is opt-in rather than the default. Grouping is also what
makes the worst addresses answerable at all: 655 E 230 St has 190,205 raw rows
in a 350m/24mo window, past Socrata's own 50,000 `$limit`, but only 1,848
grouped rows.

---

## `GET /api/complaints/group`

The individual complaints behind one grouped row.

| Param | Required | Default | Notes |
| --- | --- | --- | --- |
| `lat`, `lng` | yes | — | Must be inside NYC bounds |
| `tier` | yes | — | Supplies the radius; the caller does not pass one |
| `type` | yes | — | A known `complaint_type` string |
| `day` | yes | — | `YYYY-MM-DD` |
| `status` | no | all | `open`, `in-progress` or `closed` |
| `offset` | no | `0` | Whole number, 0–10000 |
| `limit` | no | `50` | Whole number, 1–5000 |

Returns the same row shape as the default mode, plus `X-Complaints-Has-More`.
**Paginate it** — the largest single group measured is 4,978 rows.

### Truncation — read this

Rows come back newest-first and stop at `limit`. On a dense block that means you
receive only the **most recent months**, not the full 24-month window — Bushwick
at 350m fills 1000 rows with just 148 days of data. Truncation is also uneven
between neighbourhoods, so point density is **not comparable across addresses**.

Two headers report it:

| Header | Meaning |
| --- | --- |
| `X-Complaints-Truncated` | `"true"` if the row cap was hit |
| `X-Complaints-Limit` | The cap actually applied |

Both are listed in `Access-Control-Expose-Headers`, so cross-origin JS can read
them:

```js
const res = await fetch(url);
const points = await res.json();
if (res.headers.get("X-Complaints-Truncated") === "true") {
  // showing recent activity only — say so, don't imply completeness
}
```

The response body stays a bare array because that shape is frozen. **Use this
endpoint for visual density only; take every number from `/api/score`.**

---

## `GET /api/explanation`

The slow path. Generates the AI explanation for **one** sub-score, caches it,
and returns it. Call this only when `/api/score` returned
`explanationSource: "template"` for that tier.

### Query parameters

| Param | Required | Notes |
| --- | --- | --- |
| `lat` | yes | Must be inside NYC bounds |
| `lng` | yes | Must be inside NYC bounds |
| `tier` | yes | `building` or `block` — which sub-score to explain |

### Sample request

```bash
curl "http://localhost:3001/api/explanation?lat=40.8116&lng=-73.9465&tier=building"
```

```js
const params = new URLSearchParams({ lat, lng, tier }); // tier: "building" | "block"
const res = await fetch(`http://localhost:3001/api/explanation?${params}`);
const { explanation, explanationSource } = await res.json();

// Only swap when the upgrade actually happened. A "template" response means the
// AI was unavailable and this is the same text /api/score already gave you.
if (explanationSource === "ai") swapExplanation(explanation);
```

### Response

| Field | Type | Meaning |
| --- | --- | --- |
| `explanation` | string | 1–2 sentences. Never empty, on any code path. |
| `explanationSource` | `"ai"` \| `"template"` | `"ai"` = swap it in. `"template"` = nothing to swap. |
| `mock` | `true` | **Mock mode only.** Absent otherwise. |

### Sample response — `200 OK`, AI generated

`tier=building` at 40.8116, -73.9465 (6 heat/hot water, 6 unsanitary, 5 plumbing):

```json
{
  "explanation": "Residents in this building can expect a relatively quiet maintenance record, having accumulated only 6 heat and hot water, 6 unsanitary conditions, and 5 plumbing issues over the past 24 months. These figures indicate that service calls for essential utilities and upkeep are fairly infrequent.",
  "explanationSource": "ai"
}
```

The same coordinate with `tier=block` (5475 noise, 585 parking, 174 street condition):

```json
{
  "explanation": "Residents here will experience high levels of noise, with 5475 noise complaints filed in the last 24 months. Additionally, neighbors have reported 585 illegal parking and blocked driveways issues along with 174 street and sidewalk condition grievances.",
  "explanationSource": "ai"
}
```

### Sample response — `200 OK`, template fallback

Still a `200`. This is what you get when the AI provider is down, rate-limited,
or unconfigured — and also when every bucket is `0`, where no AI call is made at
all. Handle it by doing nothing: the text you already rendered is this text.

```json
{
  "explanation": "No 311 complaints were filed in this category in the last 24 months. Residents have filed few maintenance complaints at this address recently.",
  "explanationSource": "template"
}
```

### Sample response — mock mode

`USE_MOCK_DATA=1` returns a fixed string labelled `"ai"` and carries `mock: true`.
The label is deliberate: it makes the swap-in-place path fire so the frontend
flow is testable with no AI provider running. Never treat it as generated text.

```json
{
  "explanation": "Mock explanation: this location is being served from deterministic mock data, not live 311 records.",
  "explanationSource": "ai",
  "mock": true
}
```

### Behaviour

- **Synchronous.** The client waits on this one call — there is no polling and
  no job id. A deliberate simplification.
- **One tier per call.** Explaining both means two calls, which can run in
  parallel.
- **Cached after the first generation.** A repeat call for the same coordinate
  and tier returns in a few ms without regenerating, and `/api/score` will report
  `explanationSource: "ai"` from then on. The cache shares the 24h TTL of the
  complaint counts, and is discarded when those counts refresh.
- **Always 200 with usable text.** If the AI provider is down, rate-limited, or
  unconfigured, the response carries the template text and
  `explanationSource: "template"`. There is no error state for the client to
  handle — a `"template"` response simply means there is nothing to swap.
- **No AI call when there is nothing to explain.** If every bucket is 0, the
  response is the template. Models asked to explain zero complaints produce
  contradictory text.

| Latency | Case |
| --- | --- |
| ~5–20ms | Already generated (cached) |
| ~0.7–0.9s | Gemini, fresh, complaint counts already cached |
| ~2.2–2.9s | Ollama on local CPU, fresh, counts already cached |
| **+1–2s on top** | Counts not cached — this call fetches them from NYC Open Data itself |

That last row is the one that catches people. This endpoint needs the complaint
counts before it can generate anything, so on a coordinate nobody has looked up
yet it pays the same upstream fetch `/api/score` does. Measured cold, end to
end: **~3.9s** on Gemini. Firing both calls in parallel means both requests do
that fetch; firing `/api/explanation` *after* `/api/score` resolves means the
counts are cached and only the AI cost remains. Either is fine — the template
text is already on screen — but do not size a timeout off the 0.9s row.

### Errors

400 on a missing/invalid `tier` or bad coordinates; 503 if the underlying
complaint counts cannot be fetched from NYC Open Data. An AI failure is **not**
an error — it returns 200 with the template.

```bash
$ curl "localhost:3001/api/explanation?lat=40.698&lng=-73.921"
{"error":"missing_tier","details":"tier is required (building or block)"}

$ curl "localhost:3001/api/explanation?lat=40.698&lng=-73.921&tier=roof"
{"error":"invalid_tier","details":"tier must be one of: building, block"}
```

Coordinates are validated before `tier`, so a request that is wrong in both ways
reports the coordinate problem first. Fix what you are told about, then re-send.

---


### `429 rate_limited`

Returned by every endpoint except `/health` when a caller exceeds its per-minute
budget. Carries `Retry-After` (seconds) plus `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset`.

```json
{ "error": "rate_limited", "details": "Too many requests. Try again in 42s." }
```

`details` is written to be shown to a person as-is — unlike a `400`, there is
nothing in the request to fix, so the only useful advice is when to try again.


## `GET /api/showcase`

Addresses this backend has **both a name and cached scores for**. Powers the
homepage's live report card, its "Try:" chips, and its recently-checked
carousel.

Each item is the `POST /api/score` payload with the address grafted on, so no
new client type is needed — but note `address` is a real string here, unlike on
`/api/score`, where it is always `null`.

**Cache-only, and that is the contract.** It never calls Socrata, so it cannot
be slow and cannot `503`. A cold or partly-expired cache returns *fewer* items,
or none. Render what you get; do not treat an empty list as an error.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | `6` | 1–12. |
| `mode` | enum | `top` | `top` (most looked up), `recent` (most recently looked up), `random`. |

### Sample request

```bash
curl 'http://localhost:3001/api/showcase?limit=2&mode=top'
```

### Sample response — `200 OK`

```json
{
  "fallback": {
    "address": "1 Grand Army Plaza, Brooklyn, NY 11238",
    "borough": "Brooklyn",
    "lat": 40.6743,
    "lng": -73.9704
  },
  "items": [
    {
      "address": "215 W 92nd St, New York, NY 10025",
      "borough": "Manhattan",
      "lat": 40.7921,
      "lng": -73.9732,
      "lookups": 1,
      "lastSeenAt": "2026-08-18T18:49:07.764Z",
      "curated": false,
      "buildingHealth": { "score": 100, "band": "good", "counts": { "...": 0 } },
      "blockQuality":  { "score": 32,  "band": "poor", "counts": { "...": 0 } },
      "meta": { "windowMonths": 24, "cache": { "building": "hit", "block": "hit" } }
    }
  ]
}
```

(`buildingHealth` / `blockQuality` / `meta` are elided above — they are
byte-identical in shape to [`POST /api/score`](#post-apiscore).)

### `fallback`

One curated address, **picked at random on every request**, with no scores
attached. Present on every response, empty list or not.

It is what you show when `items` is empty: a real, committed, pre-warmed address
you can fetch a live score for yourself. The homepage's hero card does exactly
that, client-side, so the rest of the page renders while it resolves.

Random rather than pinned so a cold homepage is not permanently fronted by one
building, and so no client needs its own copy of addresses and coordinates that
could drift from the set actually being warmed.

### Extra fields

| Field | Type | Notes |
|---|---|---|
| `address` | string | As the person who looked it up saw it. A coordinate keeps the first name given to it. |
| `borough` | string \| null | Derived from the address text, coordinate bounding box as fallback. `null` when neither is conclusive — render nothing, not a guess. |
| `lookups` | int | How many times this address has been reported on. `0` for a pre-warmed curated address nobody has visited. |
| `lastSeenAt` | ISO string \| null | Last lookup. |
| `curated` | bool | True for the committed pre-warmed set (`config/showcase.js`). |

### Latency

Measured ~20–30ms warm over 8 addresses — one indexed directory read plus a
cached-counts read and arithmetic per item. There is no cold case that is slow:
uncached addresses are skipped, not fetched.

### Why items go missing

The address directory has **no TTL**; the counts cache expires after 24h. A
directory row whose counts have expired is skipped, so the list thins out
between warm runs. That is the designed steady state, not a fault — see
`GET /api/warm`.

---

## `POST /api/lookups`

Records that an address was looked up, so a cached coordinate can be **named**
later. Nothing else in this system stores address text.

**Requires `Authorization: Bearer $INTERNAL_API_SECRET`, and is not callable
from a browser.** This writes the one string the app shows to other people, so
it is restricted to our own frontend, server-to-server. `401` without the token,
`503 lookups_not_configured` if the deployment has no secret set.

Deliberately not a field on `POST /api/score`: that endpoint is coordinate-only
and answers `address: null`, and this backend does not geocode. Both stay true.

### Request

```bash
curl -X POST http://localhost:3001/api/lookups \
  -H 'Content-Type: application/json' \
  -d '{"address":"88 Bedford Ave, Brooklyn, NY 11249","lat":40.7178,"lng":-73.9647}'
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | Required, 5–200 chars. Must be a real NYC street address — see below. |
| `lat` / `lng` | number | Required, must be inside the NYC bounding box. |

Do **not** send a borough — it is derived server-side and a supplied one is
ignored.

### Where the address is supposed to come from

Google, via our own server — never a browser, and never a person typing.

The frontend's geocode route resolves a Places suggestion the user picked, takes
`formattedAddress` from Google's response, and posts it here with the shared
secret. That is what makes the string trustworthy: not its shape, but its
origin. Free-text search still produces a report; it carries no `placeId`, so
nothing is recorded.

An earlier version was public and tried to judge submitted strings by shape
instead — house-number prefixes, TLD patterns. It let `"BUY CRYPTO AT
evil.example, New York, NY 10001"` through, which is what a blocklist does
eventually. The validation that remains is hygiene, applying whatever the
source: `400 invalid_address` for over 200 characters, or for control, zero-width
and bidi-override characters.

### Response — `202 Accepted`

Empty body. `202` rather than `201` because the write is advisory: a failed
directory write must not read as a failed report. You get `202` even when Mongo
is unconfigured and nothing was written — there is nothing you would do
differently.

`400` on a missing/over-long address or an out-of-NYC coordinate, same error
shape as everywhere else.

### What is stored

`{ address, borough, lat, lng, lookups, curated, firstSeenAt, lastSeenAt }`.
The coordinate is rounded to 4dp so the row joins `complaint_cache`. **No caller
identity, no session, no IP** — a row says an address was looked up, never who
looked it up.

---

## `GET /api/warm`

Fetches the curated showcase set (8 addresses with committed real coordinates,
`config/showcase.js`) from Socrata and caches it, so the homepage has real
addresses to show on a cold cache.

**The one showcase path that goes upstream: sixteen Socrata calls, measured
62s.** Never put it on a page load.

### Authentication — the only route that has any

Requires `Authorization: Bearer $CRON_SECRET`. Set `CRON_SECRET` in the
deployment's environment; on Vercel that name is special, and scheduled
invocations get the header attached automatically with no code at the call site.

| Response | When |
|---|---|
| `401 unauthorized` | Missing, malformed or wrong bearer token. |
| `503 warm_not_configured` | `CRON_SECRET` is not set on this deployment. |

**It fails closed.** Unset means nobody can warm anything — not even the cron.
Open-when-unconfigured would turn one forgotten environment variable into a
public endpoint that burns 62s of Socrata quota per request.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3001/api/warm

# Local development needs no secret at all — this bypasses HTTP entirely:
npm run warm:showcase
```

```json
{
  "warmed": 8,
  "failed": 0,
  "results": [
    { "address": "456 Park Ave, New York, NY 10022", "ok": true,
      "cache": { "building": "miss", "block": "miss" } }
  ]
}
```

Run daily. It re-fetches rather than checking first, deliberately: a cache *hit*
performs no write, so `createdAt` is untouched and the document still expires 24h
after its last fetch. Only a write slides the TTL. A daily cron
(`vercel.json → crons`) therefore keeps the set warm indefinitely; a
check-first version would not.

---

## `GET /health`

For deploy checks and keep-warm pings. No dependencies — answers even when
Mongo and Socrata are both down.

```bash
curl http://localhost:3001/health
```

```json
{ "status": "ok", "uptimeSeconds": 3 }
```

---

## Errors

All errors are JSON: `{ "error": "<code>", "details": "<human readable>" }`.
`details` is present on every 400 and on 503; it is omitted on 404 and 500,
where there is nothing useful to say that would not leak internals.

| Status | `error` | Cause |
| --- | --- | --- |
| 400 | `missing_lat` / `missing_lng` | Field absent or empty |
| 400 | `invalid_lat` / `invalid_lng` | Not a number |
| 400 | `out_of_bounds` | Outside the NYC bounding box |
| 400 | `invalid_radius` | Not 1–2000 meters |
| 400 | `invalid_limit` | Not a whole number in 1–5000 |
| 400 | `missing_tier` / `invalid_tier` | `/api/explanation` needs `tier=building` or `tier=block` |
| 404 | `not_found` | Unknown path |
| 503 | `upstream_unavailable` | NYC Open Data is not responding |
| 500 | `internal_error` | Anything else; details are not leaked |

Examples:

```bash
$ curl -X POST localhost:3001/api/score -H 'Content-Type: application/json' \
    -d '{"lat":34.05,"lng":-118.24}'
{"error":"out_of_bounds","details":"coordinate must be within NYC (lat 40.4-40.95, lng -74.3 to -73.7)"}

$ curl -X POST localhost:3001/api/score -H 'Content-Type: application/json' \
    -d '{"lng":-73.9}'
{"error":"missing_lat","details":"lat is required"}

$ curl localhost:3001/api/nope
{"error":"not_found"}
```

### Handling `503 upstream_unavailable`

NYC Open Data has gone fully dark for hours at a time. A 503 means the upstream
is down, not that the address is bad — retry, and tell the user "NYC's data
service is unavailable" rather than showing a generic failure. Cached addresses
keep working during an outage.

---

## Buckets

Six buckets across two tiers. Each is the sum of several raw 311
`complaint_type` strings.

| Tier | Bucket | 311 complaint types |
| --- | --- | --- |
| building (25m) | `heatHotWater` | HEAT/HOT WATER |
| building | `unsanitaryCondition` | UNSANITARY CONDITION |
| building | `plumbing` | PLUMBING |
| block (350m) | `noise` | Noise - Residential, Street/Sidewalk, Vehicle, Commercial |
| block | `parking` | Illegal Parking, Blocked Driveway |
| block | `streetCondition` | Street Condition, Sidewalk Condition, DEP Street Condition |

The three HPD buckets also match title-case variants (`Heat/Hot Water`, etc.) as
insurance against the city changing case. Those match zero rows today.

Deliberately excluded: Dirty Conditions (DSNY street sanitation, not a landlord
issue), General Construction/Plumbing (ambiguous), Non-Residential Heat, and
Noise - Helicopter / Park / House of Worship. See `CLAUDE.md` for the reasoning.

All variants within a bucket are summed into **one** number before scoring — the
`counts` you receive are already bucket totals, never per-string.

---

## Running locally

```bash
npm install
npm start          # http://localhost:3001
npm run dev        # same, with --watch
```

No `.env` is required — every variable below is optional, and the app boots and
answers requests with none of them set.

| Env var | Required | Purpose |
| --- | --- | --- |
| `SOCRATA_APP_TOKEN` | for live data | NYC Open Data token; requests throttle hard without it |
| `MONGODB_URI` | no | Backs the complaint cache. Local mongod in dev, Atlas SRV in prod. Without it every lookup hits Socrata |
| `MONGODB_DB` | no | `nyc-streetwise-dev` / `nyc-streetwise`; defaults to `should_i_live_here` |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | no | Defaults to 8000 |
| `MONGO_MAX_POOL_SIZE` | no | Defaults to 10 |
| `PORT` | no | Defaults to 3001 |
| `USE_MOCK_DATA` | no | `1` serves deterministic mock data |
| `AI_PROVIDER` | no | `ollama` (default, local) or `gemini` (deployed) |
| `GEMINI_API_KEY` | for `gemini` | Never commit it |
| `GEMINI_MODEL` | no | Overrides the model; default `gemini-3.5-flash-lite` |
| `GEMINI_THINKING_BUDGET` | no | Set to `0` for `gemini-2.5-*` models, omit otherwise |
| `OLLAMA_MODEL` | no | Overrides the model; default `llama3.1:8b` |
| `OLLAMA_ENDPOINT` | no | Defaults to `http://localhost:11434/api/generate` |

**No AI provider is required.** With none configured, every explanation is the
template and every endpoint still returns 200. The feature degrades, nothing
breaks.

### Local AI setup (optional)

```bash
ollama serve            # in a separate terminal
ollama pull llama3.1:8b # ~4.9GB, once
npm start               # AI_PROVIDER defaults to ollama
```

To use Gemini locally instead, put `AI_PROVIDER=gemini` and `GEMINI_API_KEY=...`
in `.env`.

Compare both providers' output on identical inputs:

```bash
npm run verify:explanations
```

### Mock mode

```bash
USE_MOCK_DATA=1 npm start
```

Serves the identical response shape with deterministic fake data — no Socrata
token, no Mongo, and no network at all. The same coordinate always returns
the same report, and all three bands are reachable. Mock payloads carry `meta.mock: true`, so nothing can
be demoed as live data by accident.

Explanations in mock mode are templates on `/api/score` and a fixed string
labelled `"ai"` from `/api/explanation`, so the swap-in-place flow fires and can
be built and tested with no AI provider running at all. See the
[mock sample](#sample-response--mock-mode) for the exact shape.

---

## Related docs

| Doc | Covers |
| --- | --- |
| `CLAUDE.md` | The spec — buckets, radii, architecture |
| `documentation/handoff.md` | Decisions, roadblocks, current state |
| `documentation/m4-m5-scoring-integration.md` | How scoring and the baseline work |
| `documentation/m6-ai-explanations.md` | How explanations work, prompt rules, model findings |
