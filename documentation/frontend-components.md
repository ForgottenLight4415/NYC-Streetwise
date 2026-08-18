# Frontend — Components (`frontend/components/`)

Grouped by what they're for, not alphabetically. All are `"use client"` where
they hold state/effects; a few (e.g. `StatusBadge`, `ScoreMeter`) are plain
presentational components with no directive needed since they're always
rendered inside an already-client tree.

## Layout

- **`Header.tsx`** — sticky top nav: logo/home link and a "Compare" link.
  Rendered once by `app/layout.tsx`, so every page gets it. Purely
  presentational — no state, no client directive.

## Search

- **`AddressSearch.tsx`** — the address input + autocomplete dropdown used on
  the landing page, report page, and both compare columns. Debounces
  (`150ms`) calls to `lib/api.ts#fetchSuggestions()`, tracks up to 5 recent
  searches in `localStorage`, and supports full keyboard navigation
  (arrow keys, Enter, Escape). Selecting a suggestion or pressing Enter calls
  either a supplied `onSelect` callback or navigates to `/report?address=...`.

## Report page (`components/ReportView.tsx` and its children)

- **`ReportView.tsx`** — the orchestrator. Reads `?address` from the URL,
  geocodes it, fetches the report, and renders the loading skeleton / error
  state / full report accordingly. See
  [`frontend-architecture.md`](./frontend-architecture.md#data-flow-for-a-single-report).
- **`VerdictBanner.tsx`** — the big Good/Fair/Poor headline + badge at the
  top of a report. Computes the overall band as the *worse* of Building
  Health and Block Quality (`lib/score.ts#overallBand`), and renders a
  one-line explanation of *why* underneath.

  That explanation area has **three states**, driven by the optional
  `aiExplanation?: { loading, tiers }` prop:

  | State | Shows |
  |---|---|
  | `loading: true` | `"Reasoning..."` (with `animate-pulse`) |
  | `tiers` non-empty | one labeled line per tier — **Building Health** and **Block Quality** — each with its own text |
  | `tiers` empty, or prop omitted | `lib/score.ts#explainVerdict()` — the deterministic client-side copy |

  The prop is optional so `CompareColumn` — which never requests an AI
  explanation — keeps the `explainVerdict` copy with no change. The fallback
  is what guarantees this area is never empty and never shows an error.

  **Both tiers always render, including template ones.** An earlier version
  merged the tiers into one paragraph and dropped any that weren't AI-backed,
  which in practice meant the Building Health line almost never appeared — see
  the note on zero-complaint buildings below.

### The AI explanation flow

`/api/score` is the fast path and **always** returns deterministic template
text so it can stay fast; a tier only reports `explanationSource: "ai"` once
`GET /api/explanation` has been called for it and the result cached
server-side. `ReportView` drives the swap:

1. After the report renders, an effect checks both tiers. If **every** tier is
   already `"ai"` (served from the backend's cache) it fires nothing — the
   text is used directly, with no `"Reasoning..."` flash.
2. Otherwise it calls `lib/api.ts#fetchExplanation()` for each `"template"`
   tier in parallel, reusing any already-`"ai"` text rather than re-paying the
   model latency for it.
3. Results are kept **per tier**, not merged. Each tier renders its AI text if
   it got one, and otherwise its own template text from `/api/score`. Only if
   *no* tier has any text at all does the banner fall back to `explainVerdict`.

> **Expect the Building Health tier to be template most of the time.** The
> building radius is 25m, and `explain.js` deliberately refuses to ask the
> model about a tier with zero complaints (llama3.1 described *zero*
> complaints as "areas of concern"). Sampling 10 spread NYC coordinates, 9 had
> zero building complaints — so `"template"` there is the normal case, not a
> failure. This is why each tier falls back to its own template text rather
> than being dropped from the list.

Two implementation details worth preserving:

- Only the *fetched* result is held in state, keyed by address so a slow
  response cannot land on the next report; the loading/cached cases are
  derived during render with `useMemo`. Setting state synchronously in the
  effect body trips the `react-hooks/set-state-in-effect` lint rule.
- Expect roughly 7s per tier against local Ollama, so this must stay
  non-blocking with the template visible meanwhile.
- **`ScorePanelCard.tsx`** — one full score panel (used twice per report:
  Building Health and Block Quality). Composes `ScoreMeter`, `StatusBadge`,
  `ComplaintBreakdownBars`, `TrendSparkline`, and `RecentComplaintsList`.
  - **Important:** the trend chart and Recent Complaints section are both
    gated on `panel.recentComplaints !== undefined`. The real backend's
    `/api/score` response never includes that field — see
    [`frontend-lib.md`](./frontend-lib.md#whats-real-vs-mocked) for what that
    means in practice.
- **`ScoreMeter.tsx`** — the circular 0–100 score gauge (SVG ring, animated
  `stroke-dashoffset`).
- **`StatusBadge.tsx`** — small pill showing a `ScoreBand` with its icon and
  themed color.
- **`ComplaintBreakdownBars.tsx`** — the "By category" list (name + count per
  bucket, no bar visualization — removed by design so only the numbers show).
  Also renders an inline "Why this score?" disclosure — a button that expands
  a sentence naming the category driving the score at the current score level.
  On BOTH panels, keyed on `tier` (`"building" | "block"`) for the wording; it
  was previously Block Quality only, gated on the display label. It picks the
  category from `bucketScores` where the API supplied them, falling back to the
  largest raw count — the same rule as `dominantBucket()` in the backend's
  `templateExplanation.js`, so the two never disagree. Was a hover tooltip once;
  replaced because it was unreachable on touch and overflowed the viewport.
- **`TrendSparkline.tsx`** — the "12-month trend" **bar chart**. Renders
  gridlines with rounded reference numbers, a "Complaints per month" caption,
  and a hover tooltip with the exact month + count. Takes `TrendPoint[]`
  (`{month, count}`) — see `lib/score.ts#buildMonthlyTrend()` for how that's
  derived from `recentComplaints` (bucketed by month, last 12 months only).
- **`RecentComplaintsList.tsx`** — the clickable list of individual
  complaints. Clicking one opens `ComplaintDetailModal`.
- **`MapPanel.tsx`** — the real Google Maps embed (not a static image).
  Loads `maps` + `marker` libraries via `window.google.maps.importLibrary`,
  places a red `AdvancedMarkerElement` at the address, and draws two
  `google.maps.Circle` overlays for the building/block radii. Includes a
  fix for a known Street View bug: dragging the Pegman onto the map can
  render a **blank black canvas** for certain panoramas (especially
  third-party 360 photos); the component listens for the panorama's
  `visible_changed`/`pano_changed` events and force-triggers a `resize` event
  (twice, since the container can still be mid-layout on the first pass) to
  kick the WebGL viewport into actually painting.
- **`ReportLoading.tsx`** — the report's loading view: `FactRotator` in the
  loaded report's container. Used for BOTH the `useSearchParams` Suspense
  boundary and `ReportView`'s own fetch, since they run back to back — two
  different placeholders made one wait look like two.

## Complaint detail modal

- **`ComplaintDetailModal.tsx`** — opens when a complaint in
  `RecentComplaintsList` or the complaints browser is clicked. Shows only what
  311 records: the complaint type, its filing date, and its current status.
  Closes on Escape or backdrop click.
  - **It used to render a "progress timeline"** — connected dots for
    Open → In Progress → Closed with dates and agency notes. That was entirely
    synthesised (311 exposes no per-complaint change log) and generated future
    dates for recent filings, so it was removed rather than patched. It also
    showed a "Complaint #" built client-side in `toComplaint()` from type +
    timestamp + row index, which read as a 311 reference number but was an
    artifact of our paging; that is gone too. The dataset's real identifier
    (`unique_key`) is not currently requested from Socrata.

## Compare page

- **`CompareView.tsx`** — renders two `CompareColumn`s and keeps their
  addresses in sync with the `?a=` / `?b=` query params.
- **`CompareColumn.tsx`** — a self-contained mini `ReportView`: its own
  `AddressSearch`, its own geocode → fetch flow, and renders
  `VerdictBanner` + two `ScorePanelCard`s + `MapPanel` once loaded.

## Landing page

- **`FeaturedCard.tsx`** — one address card in the homepage carousel: verdict
  color strip, band label, top complaint category per panel, complaint
  totals, links to the full report.
- **`FeaturedCarousel.tsx`** — auto-scrolling horizontal carousel of
  `FeaturedCard`s. Hand-rolled with `requestAnimationFrame` (not a CSS
  animation) so it can pause on hover/touch/wheel and resume smoothly,
  including subpixel scroll accumulation (tracked separately from
  `scrollLeft`, which browsers round to integers on read) and a seamless
  loop by duplicating the report list and snapping back at the midpoint.

## Icons

- **`icons.tsx`** — every icon in the app as a small inline SVG React
  component (`CheckCircleIcon`, `SpinnerIcon`, `AlertTriangleIcon`,
  `XCircleIcon`, `SearchIcon`, `MapPinIcon`, `BuildingIcon`, `BlockIcon`,
  `ChevronRightIcon`, `CloseIcon`, `ClockIcon`). No icon library dependency.
