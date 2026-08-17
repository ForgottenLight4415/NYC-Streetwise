# Streetwise — frontend

Next.js 16 (App Router) + React 19 + Tailwind v4. Address search, the two score
panels, the comparison view, and the Google Maps embed.

The scores themselves come from the separate Express API in
[`../backend`](../backend/README.md); this app geocodes the address and renders
the report.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

The backend is expected at `http://localhost:3001` — it is hardcoded as
`API_BASE_URL` in [`lib/api.ts`](lib/api.ts), not an env var. Start it too, or
the report falls back to mock data.

## Environment

```bash
cp .env.example .env.local     # gitignored
```

**Two Google Maps keys.** They are restricted differently in the Google Cloud
console and are not interchangeable — [`lib/maps-keys.ts`](lib/maps-keys.ts) is
the only place either is read, and it deliberately provides no fallback between
them.

| Var | Used by | Enable | Restrict by |
| --- | --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | `app/api/geocode`, `app/api/autocomplete` — server-side | Geocoding API, Places API (New) | **IP address** |
| `GOOGLE_MAPS_CLIENT_KEY` | the browser, via the `<script>` tag in `app/layout.tsx` | Maps JavaScript API, Advanced Markers | **HTTP referrer** |

The client key is visible in page source. That is expected and unavoidable for
the Maps JavaScript API — a referrer restriction plus per-key quota is what
contains it. The server key carries billed Geocoding/Places quota and must never
be rendered, which is the whole reason the two are separate.

### If something Google-shaped is broken

| Symptom | Cause |
| --- | --- |
| Map panel shows "Set `GOOGLE_MAPS_CLIENT_KEY`…" | client key missing, or its referrer restriction doesn't cover this origin |
| `/api/geocode` returns `REQUEST_DENIED` / 402 | the server key is **referrer**-restricted. Google refuses those on server-side APIs outright: *"API keys with referer restrictions cannot be used with this API."* Switch it to an IP restriction |
| Autocomplete returns thin/odd results | it silently fell back to the local mock list in `lib/mock-data.ts` — server key missing or rejected. Check the server console for the Google error |
| Map works but search doesn't (or vice versa) | expected: the two keys fail independently. That is the point of splitting them |

The keys are only read at request time, so adding one to `.env.local` takes
effect on the next request in `next dev` — no restart needed.

## Layout

| Path | What |
| --- | --- |
| `app/` | routes: `/`, `/report`, `/compare`, plus the `api/` route handlers |
| `components/` | all UI; see [`../documentation/frontend-components.md`](../documentation/frontend-components.md) |
| `lib/` | `api.ts` (backend calls), `maps-keys.ts`, `score.ts`, `mock-data.ts`, `types.ts` |

Fuller write-ups live in
[`../documentation/frontend-architecture.md`](../documentation/frontend-architecture.md)
and [`../documentation/frontend-lib.md`](../documentation/frontend-lib.md).

## Note on the Next.js version

[`AGENTS.md`](AGENTS.md) (surfaced to AI coding agents via `CLAUDE.md`) warns
that this project pins a Next.js newer than most training data, and points at
`node_modules/next/dist/docs/` as the authoritative reference before writing
App Router or Route Handler code. Worth reading if env-var loading or routing
behaves unlike the docs you remember.
