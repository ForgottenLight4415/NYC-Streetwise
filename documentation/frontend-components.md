# Frontend — Components (`frontend/components/`)

Grouped by feature area, not alphabetically. All are `"use client"` where
they hold state/effects/hooks; purely presentational components (icons,
badges) have no directive since they always render inside an already-client
tree. Trivial one-purpose components are mentioned in passing rather than
given their own section — read the source directly for those.

## Shared chrome

- **`Header.tsx`** — sticky top nav: logo/home link, an address search field
  pre-filled from the current `?address=` (split into its own
  `HeaderAddressSearch` component so the `useSearchParams()` client bailout
  during prerendering is scoped to just that field, not the whole bar), a
  "Compare" link, and `ThemeToggle`. Rendered once by `app/layout.tsx`.
- **`ThemeToggle.tsx`** — light/system/dark segmented control. Reads/writes
  `data-theme` on `<html>` (the single source of truth `lib/theme.ts`
  defines) via `useSyncExternalStore`.
- **`Footer.tsx`** — site-wide footer, rendered once by `app/layout.tsx`
  (previously inline in `app/page.tsx` only, so `/report`/`/compare` had no
  footer at all). Logo, data-source line, Unsplash credit, the copyright
  line, links to `/privacy`/`/terms`/`/cookies`, and a "Cookie Preferences"
  control that calls `lib/consent.ts#reopenConsentBanner()`.
- **`CookieConsent.tsx`** — the localStorage-consent banner (not a modal —
  no focus trap, page stays usable). Shown when `lib/consent.ts#getConsent()`
  is undecided, or when reopened from the footer. Accept/Decline only, no
  bare dismiss. See [`frontend-lib.md`](./frontend-lib.md#consentts).
- **`icons.tsx`** — every icon in the app as a small typed wrapper around
  Font Awesome SVG icons (`CheckCircleIcon`, `SpinnerIcon`, `BuildingIcon`,
  `TransitIcon`, `ChevronRightIcon`, ...). **`categoryIcons.tsx`** maps each
  of the six report categories to one of these as a `Record<CategoryKey, …>`
  — deliberately a *total* record, so a category added to `lib/categories.ts`
  without a matching icon is a build error, not a blank icon at runtime.

## Search

- **`AddressSearch.tsx`** — the address input + autocomplete dropdown used
  on the landing page, the header, the report page (via the toolbar's
  compare link), and both compare columns. Debounces calls to
  `lib/hooks.ts#useSuggestions()` (backed by `lib/api.ts#fetchSuggestions()`),
  tracks up to 5 recent searches via `lib/recentSearches.ts` (broadcast
  across instances via a custom DOM event so the header and homepage stay in
  sync; writes are gated on `lib/consent.ts#getConsent() === "accepted"` —
  off by default until the cookie banner is accepted), and supports full
  keyboard navigation. Selecting a suggestion passes its Places `placeId`
  through to `/report?address=...&placeId=...` so the report's geocode can
  skip straight to the Place Details lookup and (via the geocode route) get
  recorded on the showcase directory.

## Report page shell

- **`ReportView.tsx`** — the report page's orchestrator. Reads `?address`/
  `?placeId` from the URL and wires up the independent SWR hooks
  (`useCoords`, `useReport`, `usePrefetchTrends`, `useReportPanels`) described
  in [`frontend-architecture.md`](./frontend-architecture.md#data-flow-for-a-single-report),
  then hands everything to `ReportBody` with `layout="page"`.
- **`ReportBody.tsx`** — the shared body rendered by both the report page
  (`layout="page"`) and each compare column (`layout="column"`, via
  `CompareColumnContent`/`CompareAlignedBody`). Assembles: `ReportToolbar`
  (page layout only — sticky address bar + global trend-window control),
  a `VerdictBanner` + `OverviewHeader`/`ScoreRadar` split, the two complaint
  `ScorePanelCard`s plus Transit's `AmenityPanelCard` in one grid, the
  remaining amenity cards in a second grid sized by how many sections a
  report actually has (`AMENITY_COLS`, a static Tailwind-safe lookup — a
  template-string class name wouldn't survive Tailwind's build-time scan),
  and — page layout only — a sticky right rail holding `ActivitySpine` above
  `MapPanelLazy`. Column layout keeps the map inline and renders no activity
  feed at all, since the compare view fetches no complaint feeds to fill one
  with. Local UI state (trend window, which amenity bucket's browser modal is
  open) lives in the paired hook, **`useReportPanelState.ts`**, so
  `ReportBody` and `CompareAlignedBody` don't duplicate it.
- **`ReportToolbar.tsx`** — the page layout's sticky title bar: address
  heading, the global `WindowPills` trend-window control, and the "Compare
  with another" link.
- **`VerdictBanner.tsx`** — the headline: two bands side by side (Liveability
  from the two complaint tiers via `overallBand`, Access from however many
  amenity tiers are present via `overallAmenityBand`), each with its own
  one-line "why" (`lib/score.ts#explainVerdict`/`explainAccess`), plus the
  AI-generated whole-report `summary` underneath. The summary starts as
  deterministic template text and swaps to real AI text via
  `useExplanation(coords, "overall", report.summary)` — the **only** place in
  the report that ever calls `GET /api/explanation`, since every per-tier
  explanation is deterministic (see
  [`frontend-lib.md`](./frontend-lib.md#hooksts)).
- **`OverviewHeader.tsx`** — page layout only: four KPI tiles (Liveability,
  Access, a block-complaint volume tile, Nearest Transit) via **`KpiTile.tsx`**
  (which also exposes a `VolumeTile` variant that fetches its own year-
  over-year trend delta), computed from `lib/reportMetrics.ts#computeOverviewMetrics()`.
- **`ScoreRadar.tsx`** — hand-rolled SVG radar chart over the report's active
  categories (2 complaint + however many amenity sections exist), with a
  dashed ring at the 50-percentile mark since every score is literally
  anchored on the citywide median there. Renders only when at least 3 axes
  are present.
- **`ActivitySpine.tsx`** — page layout only, a chronological feed of recent
  individual complaints across both complaint tiers (**not** a per-case
  status timeline — that feature was removed entirely; see
  [`frontend-lib.md`](./frontend-lib.md#typests)). Clicking an entry opens
  `ComplaintDetailModal`; a "browse all" link opens `ComplaintsBrowserModal`
  — both lazy-loaded via `next/dynamic`.

## Score panels (complaint tiers)

- **`ScorePanelCard.tsx`** — one Building Health or Block Quality panel:
  `PanelShell` (shared chrome) plus `ComplaintBreakdownBars` and
  `TrendSection`.
- **`PanelShell.tsx`** — the chrome shared by both complaint and amenity
  panel cards: card frame, header, `ScoreMeter`, `StatusBadge`, a low-
  confidence callout (`CONFIDENCE_MESSAGE`). A `compact` prop swaps the 96px
  circular `ScoreMeter` for a smaller score chip and tightens padding — used
  throughout the dashboard layout so more cards fit per row.
- **`ScoreMeter.tsx`** — the circular 0–100 score gauge (animated SVG ring).
- **`StatusBadge.tsx`** — small pill showing a `ScoreBand` (either complaint
  or amenity vocabulary) with its icon and themed color.
- **`ComplaintBreakdownBars.tsx`** — the per-category count list plus a "Why
  this score?" disclosure (**`WhyThisScore.tsx`**, a shared expandable-text
  widget also used by `AmenityPanelCard`) naming the category driving the
  score, using the same tie-margin rule as the backend's
  `templateExplanation.js` so the two never disagree.
- **`TrendSection.tsx`** / **`TrendSparkline.tsx`** — the monthly trend bar
  chart plus its own `WindowPills` control (or, on the page layout, the
  toolbar's shared one). `TrendSparkline` renders gridlines, a caption, and a
  hover tooltip with the exact month + count from `GET /api/trend`'s
  zero-filled series.
- **`WindowPills.tsx`** — the shared trend-window radiogroup (3/6/9/12/18/24
  months), used by the toolbar, `TrendSection`, and `CompareAlignedBody`.

## Amenity panels (transit / parks / bike / walkability)

- **`AmenityPanelCard.tsx`** — the amenity sibling to `ScorePanelCard`, same
  `PanelShell` chrome plus `AmenityMetricRows` and its own "Why this score?"
  text — computed **client-side** (`lib/amenities.ts#explainAmenity()`),
  since no amenity tier ever gets a backend- or AI-computed explanation.
- **`AmenityMetricRows.tsx`** — one row per bucket that found something:
  name, walk time, distance, and (for subway/bus) route badges
  (**`TransitLineBadge.tsx`**, MTA's own official trunk-line colors, hardcoded
  hex values rather than theme tokens since they must stay identical in
  light/dark mode). A `>` affordance opens `AmenityBrowserModal` for any
  bucket except `bikeLane`/`protectedLane` — those are a resampled route
  line, not discrete places, so the backend refuses to list "every instance."
- **`AmenityBrowserModal.tsx`** — every real instance of one amenity bucket
  within its radius (`GET /api/amenities/nearby`, via
  `lib/hooks.ts#useNearbyAmenities()`), lazy-loaded via `next/dynamic`. Feeds
  both its own list and `MapPanel`'s extra markers, driven by the shared
  `useReportPanelState` hook so the same fetched data backs both.

## Complaints browser & detail

- **`ComplaintDetailModal.tsx`** — opens when a complaint in `ActivitySpine`
  or the browser is clicked. Shows only what 311 actually publishes: type,
  filing date, current status. No progress timeline — see
  [`frontend-lib.md`](./frontend-lib.md#typests) for why that was removed
  rather than kept as a stub.
- **`ComplaintsBrowserModal.tsx`** — the full grouped complaint history
  (`(day, type)` rows with a status breakdown, `GET /api/complaints?complete=1`),
  paginated (`Pager.tsx`) and filterable by month window/bucket/status
  (`FilterChips.tsx`, a shared roving-tabindex radiogroup also used by the
  trend window control). The first load per address can take seconds (the
  backend's grouped-fill cache measured 2.3–74.3s cold), so it shows
  `FactRotator` rather than a spinner. Drilling into one group fetches its
  individual complaints (`fetchGroupDetail`), also paginated.
- **`FactRotator.tsx`** — rotating trivia used by both `ComplaintsBrowserModal`'s
  first open and the report's own loading view (`ReportLoading.tsx`) — any
  wait long enough that a spinner reads as a hang. Content is hardcoded
  (`lib/nyc-facts.ts` / `lib/renting-facts.ts`), deliberately, so a screen
  whose entire job is covering for latency doesn't introduce a second thing
  that can be slow.
- **`Pager.tsx`** / **`FilterChips.tsx`** — small shared controls, extracted
  because the complaints browser needs several and a hand-rolled copy per
  site would drift.

## Compare page

- **`CompareView.tsx`** — top-level orchestrator; see
  [`frontend-architecture.md`](./frontend-architecture.md#data-flow-for-the-compare-page).
- **`CompareAddressField.tsx`** — the label + `AddressSearch` pair at the top
  of one column, shared between the "not yet loaded" and "aligned" render
  paths.
- **`CompareColumnContent.tsx`** — one column's body (placeholder/spinner/
  error/`ReportBody`) while at least one side hasn't loaded yet.
- **`CompareAlignedBody.tsx`** — once both addresses are loaded, a
  row-aligned two-column layout so matching sections (verdict, each score/
  amenity panel, radar, map) sit side by side rather than each column just
  stacking independently.

## Map

- **`MapPanel.tsx`** — the real Google Maps embed. Loads `maps`/`marker`
  libraries via `window.google.maps.importLibrary`, places an
  `AdvancedMarkerElement`, draws one `google.maps.Circle` per active category
  radius (color-matched to that category's token), and can show extra
  markers for an open `AmenityBrowserModal`. Tracks the resolved theme
  (`lib/theme.ts`) to swap the map's vector style. Includes a fix for a known
  Google Maps Street View bug (a blank black canvas after dragging Pegman
  onto certain panoramas) by force-triggering a `resize` event.
- **`MapPanelLazy.tsx`** — wraps `MapPanel` in `next/dynamic` (`ssr: false`)
  plus an `IntersectionObserver`, so the map's JS chunk and its WebGL/vector-
  tile bootstrap are deferred until the panel is nearly on screen.

## Landing page

- **`HeroSampleCard.tsx`** — the hero's live report card. Renders the
  server-fetched showcase item directly when there is one; otherwise fetches
  a live score for the backend's randomly-chosen fallback address
  client-side, without blocking the rest of the page.
- **`FeaturedCard.tsx`** — one address card in the homepage carousel: verdict
  color strip, band labels for both Liveability and Access, top category per
  panel, links to the full report.
- **`FeaturedCarousel.tsx`** — auto-scrolling horizontal carousel of
  `FeaturedCard`s, hand-rolled with `requestAnimationFrame` (not a CSS
  animation) so it can pause on hover/touch/wheel and resume smoothly,
  tracking fractional scroll position separately from `scrollLeft` (which
  browsers round to integers on read).
- **`CitywideBaselinePanel.tsx`** — real, static citywide-baseline numbers
  (`lib/citywide-baseline.ts`), shown in the carousel's slot on the homepage
  whenever fewer than 3 real cached addresses are available. Server
  component, no fetch — this is what keeps the homepage honest instead of
  showing a near-empty or duplicated carousel.

## Legal pages

- **`LegalPageLayout.tsx`** — shared shell for `/privacy`, `/terms`,
  `/cookies`: title, "last updated" date, back-to-home link, and an
  `<article>` styled via descendant selectors (no typography plugin is
  installed) so the section content can stay plain `h2`/`p`/`ul`/`a` tags.
  Plain server component, no client state.

## Misc

- **`Portal.tsx`** — renders children into `document.body`, used by every
  full-screen dialog (`ComplaintDetailModal`, `ComplaintsBrowserModal`,
  `AmenityBrowserModal`) so a dialog opened from inside the report page's
  sticky right rail (itself a stacking context) can still out-rank the
  page's other sticky elements by z-index.
