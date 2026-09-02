@AGENTS.md

# CLAUDE.md — frontend

## What this is

The Next.js frontend for **Streetwise**, an NYC address-risk tool. It
geocodes an address, calls the separate Express backend for a livability
report (two complaint-based scores plus up to four amenity-based ones), and
renders it — a report page, a side-by-side compare page, and a landing page
built from real cached backend data. This frontend **never geocodes itself**
and **never talks to Socrata, Mongo, or an AI provider** — only the backend's
HTTP API and Google's Geocoding/Places/Maps APIs.

**For anything beyond "what and why," read the module docs first — this file
is deliberately short:**

- [`../documentation/frontend-architecture.md`](../documentation/frontend-architecture.md) — pages, API routes, data flow, styling
- [`../documentation/frontend-components.md`](../documentation/frontend-components.md) — components grouped by feature area
- [`../documentation/frontend-lib.md`](../documentation/frontend-lib.md) — the API client, SWR hooks, formatting helpers
- [`README.md`](README.md) — setup: env vars, both Google Maps keys

## Architecture at a glance

No global state library or context. Each page fetches its own data via SWR
hooks in `lib/hooks.ts` (never a raw `useEffect`+`fetch`) and passes it down
as props. Three routes: `/` (server component, ISR, shows only real cached
backend data via `GET /api/showcase` — no synthesized sample reports
anywhere in this codebase), `/report` and `/compare` (client trees under a
`Suspense` boundary, since both read `useSearchParams()`).

The backend boundary is a hard line: `lib/api.ts` is the only file that
calls the Express backend, and `lib/hooks.ts` is the only place components
should reach it from. Don't call `fetch()` against `API_BASE_URL` from a
component directly.

**No mock-data fallback exists anywhere.** `fetchReport()` throws on any
failure — a backend that's down shows an error, not a fake-but-plausible
report. `ReportView`/`CompareView` catch that throw via SWR's `error` state
and render their own inline message; `app/error.tsx` (the root boundary) is
a separate, lower-level safety net for a genuine unexpected bug, not for
backend outages. Do not reintroduce a fallback that hides a real outage.

## The two Google Maps keys — never conflate them

`GOOGLE_MAPS_API_KEY` (server, IP-restricted, Geocoding/Places) and
`GOOGLE_MAPS_CLIENT_KEY` (browser, referrer-restricted, Maps JS SDK) are
read in exactly one file, `lib/maps-keys.ts`, and there is **no fallback
between them** — a `??` from one to the other is how a billed server key
ends up published in page source. See
[`frontend-architecture.md`](../documentation/frontend-architecture.md#the-two-google-maps-keys)
for the full reasoning and failure modes.

## Styling convention

Tailwind v4, but colors come from CSS custom properties defined in
`app/globals.css` (`--brand`, `--status-good`, `--series-building`,
`--transit`, ...), never Tailwind's default palette. Reference a color as
`var(--token)` or the `text-(--token)` arbitrary-value utility. This is what
makes the whole app re-themeable (light/dark) from one file — don't hardcode
a hex value in a component.

## Conventions worth knowing before changing anything

- `lib/types.ts` is written to match the backend's response contract
  field-for-field. A field added to the backend's `/api/score` response
  needs a matching addition here, and (for a new report section) a matching
  entry in `lib/categories.ts` and `components/categoryIcons.tsx` — both are
  deliberately *total* records so a missing entry is a build error, not a
  blank panel/icon at runtime.
- Every per-tier "why this score?" explanation is deterministic — either
  backend-computed (complaint tiers, arrives inline on `/api/score`) or
  computed client-side (amenity tiers, `lib/amenities.ts#explainAmenity`).
  The **only** network call to an AI model anywhere in the app is the
  whole-report summary in `VerdictBanner`, gated on
  `explanationSource !== "ai"`. Don't add a per-tier AI fetch back.
- There is no per-complaint status-change timeline feature. It was removed
  (not stubbed) because 311 doesn't publish one; don't reintroduce a
  synthesized version of it.
- Distances always render through `lib/amenities.ts#formatDistance`/
  `formatWalk`; never format meters ad hoc at a call site.
