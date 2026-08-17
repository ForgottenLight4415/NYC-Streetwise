# Backend — Architecture

`backend/` is a small Express API with one job: given a coordinate, return two
0–100 livability scores (Building Health, Block Quality) built from real NYC
311 complaint data.

## Layering

```
routes/  →  services/  →  providers/
(Express)   (orchestration    (Socrata HTTP client,
             + pure scoring)   Mongo cache, baseline loader)
```

This separation is deliberate and enforced by convention (see
[`backend/CLAUDE.md`](../backend/CLAUDE.md)):

- **Routes** (`src/routes/`) never call Socrata or Mongo directly. They validate
  input, call one service function, and translate the result (or a thrown
  error) into an HTTP response.
- **Services** (`src/services/`) do the orchestration — check the cache, fall
  back to Socrata on a miss, run scoring. `scoring.js` is a **pure function**:
  no network, no Mongo, no clock, so it's tested against fixed fixtures.
- **Providers** (`src/providers/`) are the only code that talks to the outside
  world: Socrata (NYC Open Data), MongoDB (cache + baseline), and the
  committed baseline file fallback.

## Request lifecycle — `POST /api/score`

1. `routes/score.js` validates `{lat, lng}` via `lib/validate.js` (throws
   `BadRequestError` → 400 on bad input, or rejects coordinates outside the
   NYC bounding box).
2. `services/scoreService.js#buildScoreReport(lat, lng)`:
   - If `USE_MOCK_DATA` is set, short-circuits to `mockData.js` and returns
     immediately — no network calls at all.
   - Otherwise, runs `getCounts()` and `loadBaseline()` **in parallel**.
3. `getCounts()` rounds the coordinate to ~11m precision (the cache key),
   checks Mongo for each radius tier (`building`, `block`), and for any tier
   that misses, calls `providers/socrata.js#fetchCountsForTier()` — one HTTP
   call per missing tier, issued in parallel via `Promise.allSettled` (not
   `Promise.all`, so a failure in one tier doesn't discard a successful write
   in the other). Every fetched tier is written back to the cache.
4. `services/scoring.js#buildReport(counts, baseline, meta)` turns the raw
   counts into the frozen response shape — see
   [`backend-services.md`](./backend-services.md) for how the percentile math
   works.
5. Route sends the JSON. Errors bubble to the central handler in `src/app.js`:
   `BadRequestError` → 400, `SocrataError` → 503 (`upstream_unavailable`),
   anything else → 500 with no internals leaked.

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
- **The `POST /api/score` response shape is frozen.** New fields may be added
  additively; existing fields never change name, type, or meaning without
  updating `backend/CLAUDE.md` and `backend/API.md` first. See
  [`backend-routes.md`](./backend-routes.md).

## Further reading

- [`backend-routes.md`](./backend-routes.md) — endpoint-by-endpoint reference
- [`backend-services.md`](./backend-services.md) — orchestration + the scoring algorithm
- [`backend-providers.md`](./backend-providers.md) — Socrata client, Mongo cache, baseline loader
- [`backend-config-and-scripts.md`](./backend-config-and-scripts.md) — every tunable constant, and the offline scripts
- [`../backend/API.md`](../backend/API.md) — full request/response reference with real captured samples
- [`../backend/CLAUDE.md`](../backend/CLAUDE.md) — the data-modeling decisions log (why each complaint type is in/out, known data caveats)
