<div align="center">

# Streetwise
### *Know before you sign the lease.*

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520.6-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-optional%20cache-47A248?logo=mongodb&logoColor=white)
![Google Maps](https://img.shields.io/badge/Google%20Maps-Geocoding%20%2B%20Places%20%2B%20Routes-4285F4?logo=googlemaps&logoColor=white)
![Deploy](https://img.shields.io/badge/deploy-Vercel-black?logo=vercel&logoColor=white)
![Data source](https://img.shields.io/badge/data-NYC%20311%20Open%20Data-orange)

</div>

---

## About

Renters in New York City sign leases against a wall of information they
simply don't have. A listing photo says nothing about whether the landlord
lets the heat go out every winter, whether the block is a 3am parking dispute
away from a shouting match, or whether the building has a documented pattern
of plumbing failures. That information *does* exist — it's just buried in
NYC's public 311 complaint records, scattered across hundreds of millions of
rows with no way to ask "what does this actually mean for *this* address."

**Streetwise** answers that question directly. Type an address, and the
app geocodes it, pulls every relevant 311 complaint filed near that location
over the last two years, and turns the raw counts — plus a handful of public
amenity datasets — into six things a person can actually act on:

- A **Building Health Score** (0–100) — heat/hot water outages, pests and
  mold, plumbing and leaks, disrepair, electrical and gas problems, and
  building safety (detectors, fire escapes, elevators), scoped to a tight ~25m radius so it
  reflects *this building*, not the whole block.
- A **Block Quality Score** (0–100) — noise, parking and abandoned
  vehicles, street condition, sanitation, street infrastructure, and public
  safety complaints at a ~350m radius, describing what living on this
  block is actually like day to day.
- **Transit, Parks, and Bike Access Scores** (0–100) — distance to the
  nearest subway/bus/rail, park/playground/garden, and Citi Bike dock/bike
  lane, from small static public datasets distilled once and scored from
  memory in microseconds — no live call on the request path.
- A **Walkability Access Score** (0–100) — distance to the nearest grocery
  store, restaurant, cafe, and school, the one amenity tier backed by a live
  (cached) Google Places lookup rather than a static dataset.

When a Google Routes key is configured, the amenity distances are corrected
from straight-line to real **walking distance** (one batched, cached call per
coordinate). Without it, everything still works on the free straight-line
lookup.

Every score is computed against a **precomputed citywide baseline**, so the
number isn't just a raw count or distance — it's a percentile. "7 plumbing
complaints" means nothing on its own; "worse than 85% of NYC buildings" does.
That baseline-relative scoring is the entire reason this is a *score* and not
just a tally with extra steps.

Each section also comes with a plain-English explanation of *why* it landed
where it did. The two complaint scores and four amenity scores get an instant
deterministic explanation; the whole-report summary is AI-generated (Ollama
locally, Gemini when deployed) with a deterministic template fallback, so the
feature can never show a broken or empty state.

A real Express API live-queries NYC Open Data, MTA/DOT/Citi Bike datasets,
and (for walkability and walking distances) Google Places and Routes, caching
results in MongoDB, paired with a Next.js frontend that geocodes addresses
through Google Maps and presents the report alongside an interactive map, a
complaint breakdown, a monthly trend chart, a complaints browser, and a
side-by-side address comparison view. The landing page shows real, cached
reports for recently checked addresses; the app also ships a light/dark
theme, a cookie-consent banner, and privacy, terms, and cookie pages.

---

## Table of contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [What's real vs. mocked right now](#whats-real-vs-mocked-right-now)
- [Repo layout](#repo-layout)
- [Deployment](#deployment)
- [Testing](#testing)
- [Contributors](#contributors)
- [Further reading](#further-reading)

---

## Quick start

**Prerequisites:** Node ≥ 20.6, Yarn.

The app is two independent servers — the Express backend (`:3001`) and the
Next.js frontend (`:3000`). Run both.

### 1. Backend

Two ways to run it — pick one, you don't need both:

```bash
# Option A — Docker (recommended for a fresh clone, no local installs)
cd backend
docker compose up --build
curl localhost:3001/health

# Option B — native Node
cd backend
yarn install
yarn dev                # → http://localhost:3001
```

A fresh clone runs with **zero `.env`** — every piece of backend
infrastructure (Mongo cache, AI explanations, even the Socrata token) is
optional and the app degrades gracefully without it. Set one up when you want
live data that isn't throttled, a working cache, or real AI-generated
explanations instead of the template fallback:

```bash
cd backend
cp .env.example .env
```

| Var | Required? | Notes |
|---|---|---|
| `SOCRATA_APP_TOKEN` | Recommended | Free at [data.cityofnewyork.us developer settings](https://data.cityofnewyork.us/profile/edit/developer_settings). Works without one, but requests throttle hard under load — register one before demoing. |
| `MONGODB_URI` | Optional | **Dev: local Mongo in Docker** (`mongodb://127.0.0.1:27017`, started by `docker compose up`). **Prod: Atlas** (`mongodb+srv://…`, set in the deploy host's env settings — see [`backend/.env.production.example`](backend/.env.production.example)). No code branches on environment; only this value changes. Without it, the app runs **uncached** — every request hits Socrata live, no persistence, and the homepage's recently-checked carousel stays empty (it shows one curated address instead). Scoring still works with zero Mongo, via the committed baseline fallback at `backend/src/config/baseline.json`. |
| `MONGODB_DB` | Optional | Which database inside the cluster. `nyc-streetwise-dev` locally, `nyc-streetwise` in prod — keeping them different is the only thing stopping a local experiment from writing into the Atlas cache, since an SRV URI carries no database name of its own. |
| `AI_PROVIDER` | Optional | `ollama` (default, local-only) or `gemini` (works anywhere, needs `GEMINI_API_KEY`). Neither is required — explanations fall back to a deterministic template on any failure. |
| `GOOGLE_MAPS_API_KEY` | Optional | Backend's own Google key, for Places (walkability) and the Routes API (real walking distances). Enable **Places API (New)** and **Routes API**. Without it, walkability is omitted from reports and amenity distances stay straight-line. Routes is billed per element, not per call — a cache-missing `/api/score` is 27 billed elements — so real distances are cached per coordinate for 180 days. |
| `ALLOWED_ORIGIN` | Deploy only | Comma-separated browser origins allowed to read API responses (CORS). Defaults to `http://localhost:3000`; set it to the deployed frontend's URL. |
| `CRON_SECRET` | Deploy only | Bearer secret for `GET /api/warm` and `GET /api/refresh-amenities`. **Fails closed** — unset means both answer 503. On Vercel, Vercel sends it automatically on scheduled runs. |
| `INTERNAL_API_SECRET` | Optional | Bearer secret for `POST /api/lookups`, which the frontend calls server-to-server to record the address behind each search (it feeds the homepage showcase). Must match the frontend's value. **Fails closed** — unset means no lookups are recorded. |
| `USE_MOCK_DATA` | Optional | Set to `1`/`true` to serve fake (but realistic) scores instead of hitting Socrata — useful for frontend work with no network/token/Mongo at all. |

**Full backend setup (Docker details, every env var, Ollama install/verify,
common tasks) lives in [`backend/README.md`](backend/README.md) — read that,
not this section, if something here doesn't cover your case.**

### 2. Frontend

```bash
cd frontend
yarn install
yarn dev                # → http://localhost:3000
```

Create `frontend/.env.local` yourself — it's gitignored, so it won't exist on
a fresh clone (nobody's key is committed to the repo). Start from the template:

```bash
cd frontend
cp .env.example .env.local
```

**Two Google Maps keys, not one.** They are restricted differently in the Google
Cloud console and are not interchangeable:

| Var | Called from | Required? | Notes |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | our server (`app/api/geocode`, `app/api/autocomplete`) | Yes, for real geocoding + autocomplete | Enable **Geocoding API** and **Places API (New)**. Restrict by **IP address**. Never reaches the browser. Without it, geocoding 500s and autocomplete falls back to a small seed address list (`lib/seed-addresses.ts`). |
| `GOOGLE_MAPS_CLIENT_KEY` | the browser (Maps JS SDK, loaded by `app/report` and `app/compare`) | Yes, for the interactive map | Enable **Maps JavaScript API** + Advanced Markers. Restrict by **HTTP referrer**. This one is published in page source by design — that's unavoidable for the JS SDK, which is exactly why it's a separate key. Without it, the map shows a config-needed message and the rest of the app still works. |
| `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` | the browser | Yes, for the interactive map | A vector **Map ID** from Map Management in the Google Cloud console; Advanced Markers require one. Public by design. |
| `NEXT_PUBLIC_API_BASE_URL` | the browser | Deploy only | The backend's URL. Defaults to `http://localhost:3001`. |
| `NEXT_PUBLIC_SITE_URL` | build/SEO | Deploy only | The frontend's own origin, used for absolute URLs in `robots.ts` and `sitemap.ts`. Defaults to `http://localhost:3000`. |
| `INTERNAL_API_SECRET` | our server (`app/api/geocode`) | Optional | Must match the backend's value. Deliberately **not** `NEXT_PUBLIC_`. Unset, the app works normally and simply records no lookups. |

> A key restricted by HTTP referrer **cannot** be used for the server-side
> Geocoding/Places calls — Google rejects it with `REQUEST_DENIED`
> ("API keys with referer restrictions cannot be used with this API"). If
> geocoding fails while the map renders fine, that is the reason: the server key
> needs an IP restriction, not a referrer one.

The code enforces the split — there is deliberately no fallback from one key to
the other (`frontend/lib/maps-keys.ts`), because a fallback is how a billed
server key ends up in page source.

### 3. Use it

With both running, open **http://localhost:3000**, search an NYC address
(try `123 Ludlow St, New York, NY 10002`), and you'll get a live-scored
report.

> **If the backend isn't running, the report page shows an error.**
> `fetchReport()` has no mock fallback — it throws, and the page says it
> couldn't reach the backend. For frontend-only work with no network, token, or
> Mongo, start the backend with `USE_MOCK_DATA=1` instead.

---

## Architecture

```
 Browser
   │  address search / compare
   ▼
 Next.js frontend  (frontend/, :3000)
   │  geocodes via Google  (app/api/geocode, app/api/autocomplete)
   │  POST { lat, lng }
   ▼
 Express backend  (backend/, :3001)
   │  Mongo cache (optional) → live Socrata query on a miss
   │  in-memory amenity datasets, scored the same way as complaint counts
   │  Google Routes corrects amenity distances to walking distance (optional)
   │  scores everything against a precomputed citywide baseline
   ▼
 NYC 311 Open Data (Socrata)  +  MTA/DOT/Citi Bike datasets  +  Google Places/Routes
   +  MongoDB (optional cache, address directory)
```

The backend **never geocodes** — it only ever takes `{lat, lng}`. The
frontend **never** touches Socrata or Mongo directly — it only calls the
backend's `POST /api/score` and its sibling endpoints. That boundary is
deliberate and documented in [`backend/CLAUDE.md`](backend/CLAUDE.md).

---

## What's real vs. mocked right now

Worth knowing before demoing this or building on top of it:

| Feature | Backed by real data? |
|---|---|
| Building Health / Block Quality scores | **Yes**, once the backend is running (`POST /api/score` hits live 311 data) |
| Transit / Parks / Bike / Walkability Access scores | **Yes** — the first three from committed static public datasets, the fourth from a live (cached) Google Places lookup |
| Walking distances | **Yes, when `GOOGLE_MAPS_API_KEY` is set on the backend** (Google Routes). Otherwise distances are straight-line, from the same datasets. |
| Address search, autocomplete, interactive map | **Yes**, via Google Maps APIs |
| Complaints browser, per-complaint detail, monthly trend chart | **Yes** — `GET /api/complaints` (raw and grouped modes) and `GET /api/trend` |
| Homepage sample reports / "Try:" chips | **Yes** — `GET /api/showcase`, addresses the backend has real cached scores for (kept warm by a daily cron). There is no synthesized sample data left on the landing page. |
| Per-score "why" explanation text | **Yes** for every section — deterministic template text is real, derived from the real counts/distances, never fabricated. The whole-report summary banner additionally upgrades to AI-generated text (`GET /api/explanation?tier=overall`) when a provider is configured and reachable. |
| A complaint's status-change history (Open → In Progress → Closed timeline) | **No.** 311 does not publish this at all — there was once a UI stub that synthesized one from a complaint's date and current status; it has been removed rather than kept as a stub. The detail view shows only the filing date and current status, which is everything 311 actually publishes. |

**A working-looking report is proof the backend is real**, unless the backend
was started with `USE_MOCK_DATA=1` (it logs a warning at startup, and
`meta.baselineSource` reads `"mock"`). `fetchReport()` has no mock-data
fallback on a connection failure — a backend that is down shows an error, not
a fake-but-plausible report.

---

## Repo layout

```
backend/
  src/
    routes/       score.js, complaints.js, explanation.js, health.js, trend.js,
                  showcase.js, amenities.js  (7 route modules)
    lib/          validate.js, rateLimit.js, bearerAuth.js, geo.js, borough.js, httpCache.js
    services/     scoreService.js (orchestration), scoring.js (pure scoring),
                  explain.js + templateExplanation.js / templateAmenityExplanation.js /
                  templateOverallSummary.js, amenityService.js, showcaseService.js, mockData.js
    providers/    socrata.js, cache.js, mongo.js, baseline.js, amenityBaseline.js,
                  addressDirectory.js, googleRoutes.js, googlePlaces.js,
                  amenities/ (static datasets + spatial index), ai/ (gemini.js, ollama.js, ...)
    config/       constants.js, baseline.json + amenityBaseline.json (committed fallbacks),
                  amenities/ (committed transit/parks/bike datasets)
  scripts/        buildBaseline.js, buildAmenities.js, buildAmenityBaseline.js,
                  verify*.js, warmShowcase.js
  test/           vitest suite, 700+ tests, no network required
  api/index.js    Vercel serverless entry point; vercel.json holds the rewrite + cron schedule
  Dockerfile, compose.yaml   local dev stack (API + Mongo), optional
  README.md       full backend setup — Docker, env vars, Ollama/Gemini
  CLAUDE.md       backend architecture/data notes, decisions log

frontend/
  app/            Next.js App Router pages (/, /report, /compare, /privacy, /terms, /cookies),
                  API routes (geocode, autocomplete), error.tsx, robots.ts, sitemap.ts
  components/     UI components — report panels, amenity panels, compare view, complaints browser,
                  map, homepage carousel, theme toggle, cookie consent
  lib/            api.ts (backend/Google client), score.ts, amenities.ts, types.ts, hooks.ts,
                  citywide-baseline.ts (generated), ...
  scripts/        sync-baseline.mjs (copies the backend baseline into lib/citywide-baseline.ts)

documentation/    module-by-module reference docs for this whole repo — see below
.github/workflows/monthly-baseline.yml   monthly job that rebuilds the baseline and opens a PR
.githooks/        pre-commit (lint + tests) — see Testing
```

---

## Deployment

Both halves deploy to **Vercel** as separate projects: the frontend as a
Next.js app, the backend as a serverless function (`backend/api/index.js`
exports the Express app directly). Set `ALLOWED_ORIGIN` on the backend to the
frontend's URL and `NEXT_PUBLIC_API_BASE_URL` on the frontend to the backend's;
production Mongo is Atlas (see [`backend/.env.production.example`](backend/.env.production.example)).

**Scheduled jobs**

| Job | Schedule | What it does |
|---|---|---|
| `GET /api/warm` (Vercel cron) | daily, 06:00 UTC | Re-caches the curated showcase addresses so the homepage always has real reports. Needs `CRON_SECRET`. |
| `GET /api/refresh-amenities` (Vercel cron) | monthly, the 1st at 06:00 UTC | Refreshes the Citi Bike dock dataset. Needs `CRON_SECRET`. |
| `monthly-baseline` (GitHub Action) | monthly, the 2nd at 07:00 UTC | Rebuilds the citywide complaint baseline and opens a PR. |

**Production scores against the committed baseline**, not a live one: no build
scripts run on Vercel, so a baseline refresh ships only as a committed change to
`backend/src/config/baseline.json` and the generated
`frontend/lib/citywide-baseline.ts`. The monthly Action does exactly that —
merging its PR is the deploy. After changing a bucket or the baseline by hand,
run `yarn baseline` (and `yarn baseline:amenities` for amenity changes) in
`backend/`, commit both outputs, and `yarn verify:baseline` in `frontend/`
checks they are in sync.

---

## Testing

```bash
cd backend && yarn test        # vitest, 700+ tests, no network needed
cd backend && yarn lint    # ESLint
cd frontend && yarn lint   # ESLint
cd frontend && yarn build  # type-checks + builds; no dedicated test suite yet
cd frontend && yarn verify:baseline   # fails if lib/citywide-baseline.ts is out of sync with the backend
```

**Pre-commit hook.** `.githooks/pre-commit` runs the backend's ESLint and tests
when a commit touches `backend/`, and the frontend's ESLint when it touches
`frontend/` (about 7s and 3s). Enable it once per clone:

```bash
git config core.hooksPath .githooks
.githooks/pre-commit --all    # run both checks by hand
```

It checks the working tree, so unstaged edits are included. Bypass it with
`git commit --no-verify`.

---

## Contributors

Built in one day for the hackathon by **LeonInferno**, **weijiePan**,
**Galm007**, and **ForgottenLight4415**.

---

## Further reading

Full module-by-module documentation lives in [`documentation/`](documentation/):

- [`documentation/backend-architecture.md`](documentation/backend-architecture.md) — layering, request lifecycle, design principles
- [`documentation/backend-routes.md`](documentation/backend-routes.md) — every endpoint, request/response shapes
- [`documentation/backend-services.md`](documentation/backend-services.md) — orchestration + the percentile scoring algorithm, explained
- [`documentation/backend-providers.md`](documentation/backend-providers.md) — the Socrata client, Mongo cache, baseline loader
- [`documentation/backend-config-and-scripts.md`](documentation/backend-config-and-scripts.md) — every tunable constant, and the offline scripts
- [`documentation/frontend-architecture.md`](documentation/frontend-architecture.md) — pages, API routes, data flow, styling
- [`documentation/frontend-components.md`](documentation/frontend-components.md) — every component, grouped by purpose
- [`documentation/frontend-lib.md`](documentation/frontend-lib.md) — the API client, scoring helpers, and the mock data generator

Plus:

- [`backend/README.md`](backend/README.md) — full backend setup: Docker, every env var, Ollama/Gemini install & troubleshooting
- [`backend/CLAUDE.md`](backend/CLAUDE.md) — data model, complaint-type mapping, scoring methodology, known data caveats (e.g. `streetCondition`'s 25% null-geocode rate)
- [`frontend/CLAUDE.md`](frontend/CLAUDE.md) — frontend conventions and data-flow notes
