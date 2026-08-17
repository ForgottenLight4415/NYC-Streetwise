# M3 — P2: real getCounts + Mongo cache (and the M0–M2 test backfill)

**Status:** complete, with one live check unfinished (Socrata was down — see below)
**Covers:** `src/providers/mongo.js`, `src/providers/cache.js`,
`src/services/scoreService.js`, `scripts/verifyCache.js`, and the `test/` suite
that M0–M2 never got.

## Goal

Two things:

1. **Backfill the missing tests.** M0–M2 shipped with no `test/` directory at
   all, despite CLAUDE.md specifying one. Building a cache on top of an untested
   client would have meant debugging two layers at once.
2. **Build the cache layer** — cache-first counts, Socrata on a miss, write back,
   TTL self-refresh.

## What was built

| File | Role |
| --- | --- |
| `vitest.config.js` | Test config; long timeouts for the in-memory mongod |
| `test/helpers/testServer.js` | Boots the real app on port 0, `fetch`-based client |
| `test/helpers/mongoTestServer.js` | Boots an in-memory mongod, points the provider at it |
| `test/constants.test.js` | Guards the CLAUDE.md bucket decisions (15 tests) |
| `test/validate.test.js` | Coordinate + radius validation (22 tests) |
| `test/scoring.test.js` | `bandFor` thresholds and monotonicity (4 tests) |
| `test/mockData.test.js` | Mock determinism and contract shape (11 tests) |
| `test/routes.test.js` | The frozen API contract over real HTTP (18 tests) |
| `test/socrata.test.js` | SoQL construction, bucket summing, retry policy (27 tests) |
| `src/providers/mongo.js` | Lazy connection, optional by design |
| `src/providers/cache.js` | `complaint_cache` read/write, key rounding, indexes |
| `src/services/scoreService.js` | `getCounts` — cache-first orchestration |
| `test/cache.test.js` | Cache against a real in-memory mongod (21 tests) |
| `test/scoreService.test.js` | Orchestration, real Mongo + fake Socrata (17 tests) |
| `scripts/verifyCache.js` | Live end-to-end cold/warm check, `npm run verify:cache` |

**135 tests, all passing**, no network access in any of them.

## Decisions

### Mongo is optional, not a dependency

Every cache function degrades to "miss" when Mongo is unconfigured, unreachable,
or slow, and `writeCounts` returns `false` rather than throwing. A cache outage
must not become a 500 on `/api/score` mid-demo — the cost of a cache miss is
latency, and that is the correct thing to pay when the cache is broken.

Index creation at boot is deliberately **not awaited** before `listen()`. A slow
Atlas cluster must not delay `/health`, which is what a host uses to decide
whether the deploy succeeded.

Connection timeouts are 5s and overridable via
`MONGO_SERVER_SELECTION_TIMEOUT_MS`, so the "Atlas is down" test path runs in
300ms instead of stalling the suite for 10s.

### The Socrata query uses the ROUNDED coordinate

This is the non-obvious one. The cache key is the coordinate rounded to 4dp
(~11m), but the query could reasonably use either the raw or the rounded value.

It uses **rounded**. If it used the raw coordinate, two addresses sharing a cache
key would get whichever circle happened to be queried first, so a cache hit and a
cache miss would silently describe different circles — the same address returning
different numbers depending on who looked it up first. Rounding first makes the
key and the query agree. The cost is moving the circle's centre by up to ~8m,
comfortably inside the 25m building radius.

### Partial documents are treated as a miss

`readCounts` rejects any cached document whose bucket set is incomplete or
non-numeric. A missing bucket enters the scoring mean as `NaN` and silently
poisons an entire sub-score; re-fetching is far cheaper than shipping a `NaN`.

Zero counts, by contrast, are preserved as a **hit** — an all-zero building
result is real data that M4 will flag as low-confidence, and must not be
indistinguishable from a miss.

### `createdAt` must be a BSON `Date`

Stored as a `Date`, never a string. Mongo's TTL monitor silently ignores
documents whose indexed field is not a date, so a string `createdAt` produces a
cache that appears correct and never expires. There is a test asserting the type
specifically because the failure is invisible.

Every write refreshes `createdAt`, making the TTL a sliding 24h window rather
than a hard expiry 24h after first insert.

### The compound index is `unique`

Two concurrent misses for the same address would otherwise write two documents
for the same circle, with reads flipping between them. Uniqueness plus
`replaceOne(..., {upsert: true})` collapses that to one document; a test fires
five concurrent writes and asserts a single document results.

### `Promise.allSettled`, not `Promise.all`

Found by a test that passed alone and failed in the full suite. `Promise.all`
short-circuits on the first rejection, so when the building tier failed, the
block tier's cache write was abandoned mid-flight — throwing away an HTTP call
that had already succeeded. With `allSettled`, both tiers settle, the successful
one is persisted, and the first rejection is then rethrown. A retry after a
partial failure now only pays for the tier that actually failed.

## Roadblocks hit

### 1. The mock was not actually deterministic

`mockComplaints` built `created_date` from `Date.now()`, so two calls
milliseconds apart returned different timestamps. The handoff promises
"deterministic per coordinate", and the frontend relies on it; the route test
comparing two identical requests is what caught it.

**Fixed:** the timestamp base is quantized to the UTC day. Same coordinate now
gives byte-identical responses within a day.

### 2. Socrata was down mid-milestone (since RESOLVED — outage over, checks rerun)

For several hours the dataset returned `503 Site Currently Unavailable` to
everything, including a plain `curl`, so `npm run verify:cache` could not complete
its live half:

```
$ curl -s -o /dev/null -w "%{http_code}" \
    "https://data.cityofnewyork.us/resource/erm2-nwe9.json?\$limit=1"
503        # "Site Currently Unavailable"
```

The retry policy behaved correctly (3 attempts, then a `SocrataError` naming the
status). The script now reports the outage and exits 2 instead of dumping a stack
trace, and still runs its Mongo/index checks — which is how the Mongo half got
verified during the outage.

The API came back the same day and **every live check has since been run and
passes** (see "Verified live" below). `verifyDataset.js` was re-run too: the
dataset did not move during the outage, and all M2 findings hold unchanged.

**The demo risk this exposed is real and remains open** — an external 503 is
exactly the failure P5 was written for, and it is now known to happen to this
dataset. See the handoff's watch items.

### 3. `MONGODB_URI` was not empty after all

The M2 handoff recorded it as unset and expected M3 to develop against a
throwaway local Mongo. In fact `.env` already points at a local
`mongodb://localhost:27017/should-i-live-here` and mongod is running, so the
verification script exercised a real server. Atlas is still needed before deploy.

## Verified live

`npm run verify:cache`, against the real local mongod and the live API. All 10
checks pass across two boroughs.

```
=== Indexes on complaint_cache ===
  _id_             {"_id":1}
  coord_tier       {"lat":1,"lng":1,"radiusTier":1}  unique
  createdAt_ttl    {"createdAt":1}  TTL=86400s (24h)

=== Bushwick, Brooklyn (40.698, -73.921) ===
  cold (Socrata)                 1608 ms
  warm (cache)                      2 ms
  nearby coord (same key)           2 ms
  building: {"heatHotWater":5,"unsanitaryCondition":0,"plumbing":1}
  block:    {"noise":2876,"parking":1253,"streetCondition":144}

=== Midtown, Manhattan (40.7549, -73.984) ===
  cold (Socrata)                 2484 ms
  warm (cache)                      2 ms
  nearby coord (same key)           1 ms
  building: {"heatHotWater":2,"unsanitaryCondition":3,"plumbing":2}
  block:    {"noise":834,"parking":1116,"streetCondition":302}
```

Both indexes present, TTL at the specified 24h, compound index unique, and **no
2dsphere index** — asserted by a test, because spatial filtering is Socrata's job
and a 2dsphere index here would be a silent invitation to move it.

**The cache is worth roughly 1000x on latency** (1.6–2.5s → 2ms), and a nearby
coordinate that rounds onto a stored key hits it. Note also that cold latency is
now 1.6–2.5s, not the 11s M2 recorded — M2 measured the very first query of a
novel shape, which is a worse case than a warm dataset-side cache.

The counts also stay discriminating in the direction the score depends on:
Bushwick's block circle carries 2,876 noise complaints against Midtown's 834,
while Midtown carries more than double the streetCondition.

### `fetchComplaints` — first live exercise, and one real problem

The heatmap path was written in M2 but never run against live data. It is clean
on data quality: across three locations, **zero NaN coordinates, zero unparseable
dates, zero null statuses, and zero complaint types outside our buckets**. The
25.60% streetCondition null-geocoding rate does *not* leak into the heatmap —
`within_circle` on `location` excludes null-geo rows for free.

But the 1000-row cap truncates the window badly at block radius:

| location | radius | rows | window actually covered |
| --- | --- | ---: | --- |
| Bushwick | 350m | 1000 (capped) | most recent **148 days** of 730 |
| Midtown | 350m | 1000 (capped) | most recent **281 days** of 730 |
| Bushwick | 25m | 39 | full 720 days |

Because `$order: created_date DESC` truncates newest-first, a dense block returns
only its most recent months. Two consequences, both for **M5**:

1. **The heatmap and the score disagree.** The score counts 2,876 noise
   complaints over 24 months in Bushwick's 350m circle; the heatmap shows at most
   1000 points of *everything* from the last 5 months. If the frontend ever
   derives a number from the heatmap, it will contradict the headline score.
2. **The truncation is uneven across locations** (148 vs 281 days), so heatmap
   density is not comparable between neighbourhoods — the denser block looks
   *relatively* sparser than it is.

Not fixed here: the route still serves mock points, so nothing is user-facing
yet, and the fix is a contract-adjacent choice (raise the cap, sample across the
window, or document the endpoint as "most recent N"). It belongs to M5 with
Person 2 in the loop. Flagged in the handoff.

## What was NOT done, deliberately

- **Routes still serve mock data.** M3 is cache and count plumbing only; swapping
  the mock is M5, and doing it early would have broken the frontend's known-good
  fixture mid-milestone.
- **No stale-serving on Socrata failure.** That is P5/M6, and it interacts with
  the TTL — see the handoff.
- **No `score()` function.** M4, alongside the baseline it scores against.
