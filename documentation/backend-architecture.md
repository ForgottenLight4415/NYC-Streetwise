# Backend — Architecture

`backend/` is a small Express API with one job: given a coordinate, return a
livability report — two complaint-based scores (Building Health, Block
Quality), up to four amenity-based scores (Transit/Parks/Bike/Walkability
Access), and a plain-English summary — built from real NYC 311 data and a
handful of small static/live amenity sources.

## Layering

```
routes/  →  services/  →  providers/
(Express,    (orchestration    (Socrata HTTP client, Mongo cache,
 validation,  + pure scoring)   baseline loader, amenity datasets,
 rate limits)                   Google Routes/Places, AI adapters)
```

This separation is deliberate and enforced by convention (see
`backend/CLAUDE.md`):

- **Routes** (`src/routes/`, 9 modules — see
  [`backend-routes.md`](./backend-routes.md)) never call Socrata, Mongo, or an
  AI provider directly. They validate input (`lib/validate.js`), apply a
  per-caller rate limit sized to what the call costs (`lib/rateLimit.js`),
  call one service function, and translate the result (or a thrown error)
  into an HTTP response.
- **Services** (`src/services/`) do the orchestration — check the cache, fall
  back to Socrata/Google on a miss, run scoring. `scoring.js` is a **pure
  function**: no network, no Mongo, no clock, so it's tested against fixed
  fixtures and shared unmodified between the complaint tiers and the
  distance-scored amenity tiers.
- **Providers** (`src/providers/`) are the only code that talks to the
  outside world: Socrata (NYC Open Data), MongoDB (cache + baseline +
  amenity datasets), the committed baseline/amenity file fallbacks, Google
  Routes/Places, and the AI explanation adapters.

## Request lifecycle — `POST /api/score`

1. `routes/score.js` validates `{lat, lng}` via `lib/validate.js` (throws
   `BadRequestError` → 400 on bad input, or rejects coordinates outside the
   NYC bounding box) and applies `RATE_LIMIT_UPSTREAM`.
2. `services/scoreService.js#buildScoreReport(lat, lng)`:
   - If `USE_MOCK_DATA` is set, short-circuits to `mockData.js` and returns
     immediately — no network calls at all.
   - Otherwise, runs `getCounts()`, `loadBaseline()`, and the amenity/
     walkability lookups **together**.
3. `getCounts()` rounds the coordinate to ~11m precision (the cache key),
   checks Mongo for each radius tier (`building`, `block`), and for any tier
   that misses, calls `providers/socrata.js#fetchCountsForTier()` — one HTTP
   call per missing tier, issued in parallel via `Promise.allSettled` (not
   `Promise.all`, so a failure in one tier doesn't discard a successful write
   in the other). Every fetched tier is written back to the cache.
   The transit/parks/bike tiers are a free in-memory grid lookup against data
   loaded once at process start; walkability is the one section that can make
   a live, billed Google Places call on a cache miss.
4. `services/scoring.js#buildReport()`/`scoreTier()` turns raw counts and
   amenity distances into the response shape, and `services/explain.js`
   attaches a deterministic template explanation to every section plus the
   cached-or-template whole-report `summary` — see
   [`backend-services.md`](./backend-services.md) for how the percentile math
   and the AI explanation layer work.
5. Route sends the JSON. Errors bubble to the central handler in `src/app.js`:
   `BadRequestError` → 400, `SocrataError` → 503 (`upstream_unavailable`),
   a tripped rate limit → 429 (`rate_limited`), anything else → 500 with no
   internals leaked.

## App wiring (`src/app.js`)

- `createApp()` builds the Express app **without** starting a listener, so
  tests and `src/index.js` share exactly one wiring path.
- Open CORS (`Access-Control-Allow-Origin: *`) — the frontend runs on a
  different origin in dev.
- Explicitly exposes `X-Complaints-Truncated` / `X-Complaints-Limit` via
  `Access-Control-Expose-Headers` — without this, browser JS can't read those
  headers even though they arrive over the wire.
- Central error-handling middleware is the single place HTTP status codes get
  decided; routes just throw.

## Entry point (`src/index.js`)

- Reads `PORT` (default `3001`), starts the listener.
- Fires off two **non-blocking** startup tasks (not awaited before
  `app.listen`, so a slow/missing Mongo or baseline never delays the app from
  answering `/health`):
  - `ensureCacheIndexes()` if a usable `MONGODB_URI` is set (local mongod in
    dev, Atlas in prod — same code path either way).
  - `loadBaseline()` (skipped entirely in mock mode) — memoized for the
    process lifetime, so this pays the one-time Mongo/disk read cost at boot
    rather than on the first user's request.
- Graceful shutdown on `SIGINT`/`SIGTERM`: stop accepting connections, close
  the Mongo client, exit.

## Design principles worth knowing before changing anything

- **Optional infrastructure everywhere.** No `MONGODB_URI` — or one still
  holding Atlas's `<db_password>` placeholder? The app runs uncached, not
  broken. No baseline in Mongo? Falls back to the committed
  `src/config/baseline.json`. No Socrata token? Requests still work,
  unauthenticated, just throttled harder. Nothing here throws at startup for
  a missing credential — see `providers/mongo.js`, `providers/baseline.js`.
- **Live-proxy + cache, not bulk ingest.** The dataset has hundreds of
  millions of rows; the backend never stores more than aggregate counts per
  coordinate (and a bounded number of individual points for the heatmap
  endpoint). See `CLAUDE.md` → Conventions.
- **The `POST /api/score` response shape is append-only.** New fields (the
  amenity sections, `summary`, `bucketStatusCounts`, ...) have all been added
  additively; existing fields never change name, type, or meaning without
  updating `backend/CLAUDE.md` first. See [`backend-routes.md`](./backend-routes.md).

## Further reading

- [`backend-routes.md`](./backend-routes.md) — endpoint-by-endpoint reference, all 9 route modules
- [`backend-services.md`](./backend-services.md) — orchestration + the scoring algorithm + explanations
- [`backend-providers.md`](./backend-providers.md) — Socrata client, Mongo cache, baseline loader, amenity datasets, Google/AI providers
- [`backend-config-and-scripts.md`](./backend-config-and-scripts.md) — every tunable constant, and the offline scripts
- [`../backend/CLAUDE.md`](../backend/CLAUDE.md) — the data-modeling decisions log (why each complaint type is in/out, known data caveats, full API contract)
