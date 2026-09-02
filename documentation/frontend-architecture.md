# Frontend — Architecture (`frontend/`)

Next.js 16 (App Router), React 19, Tailwind v4. No global state
library/context — each page fetches its own data via SWR hooks
(`lib/hooks.ts`) and passes it down as props. Data fetching is centralized in
`lib/api.ts`/`lib/hooks.ts`; nothing outside those talks to the network.

## Pages (`app/`)

| Route | File | What it does |
|---|---|---|
| `/` | `app/page.tsx` | Landing page. Server component, ISR (`revalidate = 300`). Fetches `GET /api/showcase` once for the hero card, the address chips, and the carousel — no synthesized/mock data anywhere. Below `MIN_CAROUSEL_ITEMS` (3) it shows `CitywideBaselinePanel` (real, static baseline data) instead of a near-empty carousel. |
| `/report?address=&placeId=` | `app/report/page.tsx` → `components/ReportView.tsx` | The main report screen. Client component tree wrapped in `<Suspense fallback={<ReportLoading />}>` because it reads `useSearchParams()`. The page itself is a server component whose only job is deciding whether to inject the Maps JS `<script>` tag (see below) — the map SDK is requested per-route, not from the root layout, since `/` never renders a map. |
| `/compare?a=&b=` | `app/compare/page.tsx` → `components/CompareView.tsx` | Two addresses side by side, each independently searchable, synced to `a`/`b` query params via `router.replace`. Same Maps-script-injection pattern as `/report`. |

`app/layout.tsx` is the root layout: loads three fonts (Archivo for display,
Lato for body, IBM Plex Mono for data/numbers — all deliberate choices, see
the file's own comments), inlines a theme-detection script into `<head>`
before first paint (`lib/theme.ts#THEME_INIT_SCRIPT`, avoids a light/dark
flash), renders `<Header>`, and preconnects to the Express backend's origin
(the first call on every page's critical path). It does **not** load the
Google Maps SDK — that moved to `/report` and `/compare` specifically, so the
homepage isn't paying for a third-party bootstrap it never uses.

## The two Google Maps keys

`lib/maps-keys.ts` is the only place either key is read, and it keeps them
strictly separate:

| Accessor | Env var | Caller | Google restriction |
|---|---|---|---|
| `serverMapsKey()` | `GOOGLE_MAPS_API_KEY` | `app/api/geocode`, `app/api/autocomplete` (server-side) | IP address |
| `clientMapsKey()` / `mapsScriptSrc()` | `GOOGLE_MAPS_CLIENT_KEY` (legacy alias: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) | the browser, via a `<script async src>` injected by `app/report/page.tsx` / `app/compare/page.tsx` | HTTP referrer |

There is **no fallback between them**, on purpose. The client key is
published in page source — unavoidable for the Maps JavaScript API, and fine
because a referrer restriction contains it. The server key carries billed
Geocoding/Places quota and has no referrer to restrict it by, so it must
never be rendered; a `??` fallback from one to the other is precisely how
that happens. Practical consequence: Google refuses a referrer-restricted key
on the server-side Geocoding/Places endpoints outright
(`REQUEST_DENIED`) — a blank map with a working search box is always a
*client*-key problem, and vice versa.

A third, separate export, `mapId()`, holds the Map Style ID (`NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`) used to attach a cloud-based vector style to `MapPanel`'s
map — the Maps JS API rejects a `styles` array on any map that also sets
`mapId`, so this is the only styling path available.

## API routes (`app/api/`)

Next.js Route Handlers — same-origin proxies the browser calls, distinct
from the separately-deployed Express `backend/` API.

| Route | Purpose |
|---|---|
| `api/geocode/route.ts` | Google Geocoding + Places Details proxy. Takes `?address=` or `?placeId=`, returns `{ address, lat, lng, placeId }`. Uses `serverMapsKey()`. In-process TTL-cached (`lib/lru.ts`, 12h) since a building's coordinates never change. On the `placeId` path only, fires `recordLookup()` (via `next/server`'s `after()`, so the write survives after the response is sent) to record the address on the backend's showcase directory — see [`frontend-lib.md`](./frontend-lib.md#record-lookupts). The free-text path never records anything: it has no comparable provenance guarantee. |
| `api/autocomplete/route.ts` | Google Places Autocomplete (New) proxy, restricted to a hard NYC bounding box plus a `", NY,"` state-suffix filter (Staten Island shares its harbor waterfront with NJ). Also TTL-cached (10 min, keyed by normalized query prefix — every keystroke is a separate billed call). Falls back to `lib/seed-addresses.ts#findSuggestions()` when no server key is configured *or* the live Google call fails, so the search box stays usable offline. |

There is no legacy mock-report route — the only frontend API routes are
these two, both real Google proxies.

## Data flow for a single report

```
AddressSearch (user types/selects, or a "Try:" chip / compare link is clicked)
   │ router.push(`/report?address=...&placeId=...`)
   ▼
ReportView
   │ useCoords(address, placeId)   — lib/hooks.ts, geocodes via /api/geocode
   │ useReport(coords)             — POST to the Express backend's /api/score
   │ usePrefetchTrends(coords)     — warms both tiers' /api/trend in the background
   │ useReportPanels(coords, report) — per-tier /api/complaints feeds, independent of the score
   ▼
ReportBody → ScorePanelCard × 2, AmenityPanelCard × up to 4, VerdictBanner,
             OverviewHeader (KPI tiles + ScoreRadar), ActivitySpine, MapPanelLazy
```

Every fetch above is an independent SWR hook (`lib/hooks.ts`), not a
sequential `await` chain — this is a deliberate rewrite from an earlier
version where the whole page waited on the slowest thing before painting
anything. SWR's own dedup means two components asking for the same key (e.g.
two `ScorePanelCard`s' trend fetch, or the compare page's two columns) issue
one request. See [`frontend-lib.md`](./frontend-lib.md#hooksts) for exactly
what each hook does and why it's not a plain `useEffect`.

The AI-generated whole-report `summary` is the one exception to "always
instant": `VerdictBanner` calls `useExplanation(coords, "overall", report.summary)`,
which only fires a `GET /api/explanation` request when
`report.summary.explanationSource` is `"template"` — every other section
(both complaint tiers, all four amenity tiers) gets a deterministic
explanation with no extra request at all (backend-computed for the complaint
tiers, computed client-side in `lib/amenities.ts#explainAmenity()` for the
amenity tiers).

## Data flow for the compare page

`CompareView` holds two independent `useCoords`/`useReport` pairs (one per
`a`/`b` query param) and renders one of two shapes depending on whether both
sides have resolved:

- **Not yet (either side loading/missing):** `CompareAddressField` (the
  label + search box) plus `CompareColumnContent` (placeholder/spinner/error/
  `ReportBody` in `layout="column"` mode) for each side independently.
- **Both loaded:** `CompareAlignedBody` — a row-aligned layout so matching
  sections (verdict, each score panel, the radar, the map) line up between
  the two columns instead of each column just stacking independently. This
  reuses the exact same `useReportPanelState` hook `ReportBody` uses, called
  once per address.

The compare view never fetches complaint feeds or the activity spine — it
passes no `panels` prop to `ReportBody`/`CompareAlignedBody`, which is also
what makes those components skip the activity-feed rail (see
[`frontend-components.md`](./frontend-components.md#report-page-shell)).

## Styling

Tailwind v4, configured via `app/globals.css` using CSS custom properties
(`--brand`, `--status-good`, `--series-building`, `--transit`, `--surface-1`,
etc.) rather than Tailwind's default palette — every component references
colors as `var(--token)`, either inline (`style={{ color: "var(--brand)" }}`)
or via the `text-(--token)` arbitrary-value utility. This is what makes the
whole app re-themeable (light/dark, see `lib/theme.ts`) from one file.
Contrast ratios are commented inline in `globals.css` and checked by
`scripts/check-contrast.mjs`.

Each of the six report categories (2 complaint + 4 amenity) has its own
`--series-*`/status-independent color pair (e.g. `--transit`/`--transit-ink`)
defined in `lib/categories.ts` and used consistently across the score
panels, the map's radius rings, and the radar chart.

## A note on this Next.js version

`frontend/AGENTS.md` (pulled into `frontend/CLAUDE.md` via an `@AGENTS.md`
import, and regenerated automatically by `next dev` — don't hand-edit it)
warns that this project pins a Next.js version newer than most training
data, and points at `node_modules/next/dist/docs/` as the authoritative
reference before writing App Router / Route Handler code here.

## Further reading

- [`frontend-components.md`](./frontend-components.md) — components grouped by feature area
- [`frontend-lib.md`](./frontend-lib.md) — the API client, hooks, scoring/formatting helpers
