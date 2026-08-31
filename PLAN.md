# Report page → dashboard layout

## Context

The report page (`/report`) is a tall vertical stack: verdict banner → two wide Score panels → three wide Amenity panels → map. Every card is the same width, the same weight, and the same `p-5 sm:p-6` box, so nothing reads as more important than anything else, and the three amenity cards alone spend a full viewport on nine numbers. The first screen shows a verdict and the tops of two cards; the answer to "is this address good?" is ~2.5 screens away.

The reference dashboard screenshot fixes exactly this with a three-tier IA: a sticky title bar with global controls, a compact KPI strip, then an asymmetric bento grid. This plan ports that IA onto the report page.

Two things make it cheap:

- **No new network requests.** Every number comes from the single `/api/score` response or the 24-month trend series that `usePrefetchTrends` (`frontend/lib/hooks.ts:156`) already warms at geocode time. Year-over-year, the citywide-median benchmark, and `bucketConfidence` are all in hand today and rendered nowhere.
- **No color changes.** `frontend/app/globals.css:23-203` stays byte-identical. The `--x` / `--x-ink` pairing (graphic fill at 3:1, text ink at 4.5:1) is load-bearing and verified by `frontend/scripts/check-contrast.mjs`; new components consume existing tokens only.

Design direction from `ui-ux-pro-max`: **Data-Dense Dashboard** + **Bento Box Grid**, density 8/10 (8–32px spacing), motion 3/10 (subtle only). Performance rules from `vercel-react-best-practices` cited by rule id.

**Honest framing:** this does not make the page shorter — it adds a KPI strip, a radar, and an activity feed, and compresses the amenity row to pay for part of it. What it changes is that the first screen now *answers the question* instead of introducing it.

---

## Decisions taken

| Decision | Choice |
|---|---|
| Scope | Full restructure — sticky toolbar, KPI strip, bento grid |
| Wide bento widget | Hand-rolled SVG score radar, with a dashed ring at 50 = "NYC median" |
| Time window | One global control in the toolbar; `months` lifts out of `ScorePanelCard` |
| Amenity metric rows | **All rows stay visible** — no `<details>`, no progressive disclosure |
| Amenity meters | 96px donut → score chip + existing `StatusBadge` per card |
| Walkability | **Not built here.** Every new widget is driven by `lib/categories.ts`, so a 6th category drops in with zero layout work |

---

## Target layout (`layout="page"`)

```
┌─ 123 Ludlow St, Manhattan ──── [3 6 9 12 18 24] [Compare] ┐  sticky, z-30
├───────────────────────────────────────────────────────────┤
│  Verdict banner — Liveability │ Access        (unchanged)  │
├─────────────┬─────────────┬──────────────┬────────────────┤
│ Liveability │   Access    │ Block volume │ Nearest subway │  StatStrip
│   72 /100   │   84 /100   │ 431  ▼ -12%  │  4 min · Delancey
├─────────────┴─────────────┼──────────────┴────────────────┤
│  Neighborhood profile     │  Recent activity              │  bento
│         ╱‾╲               │  06 Aug ─●─ Heat/Hot Water    │  xl:grid-cols-4
│        ╱   ╲  5 axes now  │  04 Aug ─●─ Noise · open      │  2 + 2
│        ╲   ╱  6 with walk │  01 Aug ─●─ Illegal Parking   │
│         ╲_╱   ⌇NYC median │  [Browse building] [Browse block]
├───────────────────────────┴───────────────────────────────┤
│  Building Health          │  Block Quality                │  lg:grid-cols-2
│  meter · bars · why · trend                               │  (lists moved out)
├─────────────────┬─────────────────┬───────────────────────┤
│ Transit  84 ●   │ Parks  71 ●     │ Bike  66 ●            │  compact cards
│ Subway  4 min   │ Park    3 min   │ Dock    2 min         │  ALL rows visible
│ Bus     2 min   │ Playgrd 6 min   │ Lane    1 min         │  3 now → 4 later
│ Rail   21 min   │ Garden 11 min   │ Prot.   4 min         │
├───────────────────────────────────────────────────────────┤
│  Map                                          (unchanged) │
└───────────────────────────────────────────────────────────┘
```

`layout="column"` (the `/compare` columns) keeps its single-column stack and gains the radar — two radars side by side is the strongest thing compare can show. It omits the toolbar and StatStrip (too wide for a half page) and the activity spine (compare passes no `panels`, so it has no feed).

---

## What moves, and what is actually lost

| Today | New home |
|---|---|
| Address `<h1>` in `VerdictBanner` | Sticky toolbar — visible while scrolling instead of scrolling away |
| Verdict halves + per-tier AI text | Unchanged |
| Building/Block meter, badge, summary, category rows, "Why this score?", trend | Unchanged, same 2-up cards |
| Per-panel window pills ×2 | One toolbar control |
| Per-panel "Recent complaints" ×2 (5 rows each) | One merged `ActivitySpine`, tier-colored, 8 rows — **replaces** both, so the same complaints are not listed twice |
| "Show all N" → `ComplaintsBrowserModal` ×2 | Two buttons in the spine footer; both tier-scoped entry points survive |
| Amenity `AmenityMetricRows` (9 rows, name / walk time / "N within 800m") | Unchanged, still always visible |
| Amenity description, `StatusBadge`, confidence callout | Unchanged |
| Map | Unchanged |

**Genuinely lost: three 96px amenity donut meters.** The score, band, and badge all survive as a chip + badge, and the radar plots the same three scores as axes — but the donut visual for transit/parks/bike goes.

**Net gained**, none of which renders anywhere today: year-over-year complaint delta, the citywide-median benchmark ring, `bucketConfidence` caveats, and a `<main>` landmark on the route.

---

## Sixth-category readiness (walkability)

Nothing in the new layout hardcodes five categories. Adding a `WALKABILITY` entry to `AMENITY_CATEGORIES` in `frontend/lib/categories.ts` (plus its `colorVar` token pair and a `categoryIcons` entry) is expected to be the entire frontend layout cost:

- **Radar** takes `axes: {label, score, colorVar}[]` and computes its geometry from `axes.length`. Five axes today; six is the screenshot's hexagon exactly.
- **Amenity grid** column class comes from a static lookup keyed on category count, so 3 → `xl:grid-cols-3` and 4 → `xl:grid-cols-4` with no orphan hole:
  ```ts
  // Static strings, not interpolated — Tailwind v4 only sees literals in source.
  const AMENITY_COLS: Record<number, string> = {
    1: "", 2: "md:grid-cols-2", 3: "md:grid-cols-2 xl:grid-cols-3", 4: "md:grid-cols-2 xl:grid-cols-4",
  };
  ```
- **StatStrip** is hand-picked, not per-category, so it needs no change.
- `useReportPanels` (`lib/hooks.ts`) is already a **total** `Record<CategoryKey, …>`, so a new category is a compile error there until wired — that safety net stays intact.

The backend side (a new amenity tier, a Google Places pipeline with a distilled snapshot so it stays off the request path, a baseline sample, scoring, explanations, tests) is out of scope here and unaffected by this plan.

---

## New files

### `frontend/lib/reportMetrics.ts` — pure, no React
- `monthsAgoISO(months)` — **moved** from `ScorePanelCard.tsx:12-16`; `ActivitySpine` needs the same prefix filter.
- `sliceWindow(points, months)` — lift the inline slice from `TrendSection.tsx`.
- `windowTotal(points, months)` — replaces the ad-hoc sum at `TrendSection.tsx:80`.
- `yoyDelta(points)` — `sum(last 12)` vs `sum(prior 12)` → `{ current, prior, pct } | null`; `null` under 24 points. The series is zero-filled server-side (`backend/src/routes/trend.js`), so a missing month is a real zero and the sums are sound.
- Comment the polarity: for complaints a **negative** delta is good, so the caller maps `pct < 0 → --status-good-ink`. The one place the green-up convention inverts.

### `frontend/components/StatTile.tsx` — server component
Presentational only, no `"use client"` (rule *Server Components by default*). Props `{ label, value, unit?, sub?, icon, colorVar, band?, delta? }`.

Chrome mirrors `PanelShell.tsx:48-54` but denser (density 8 → `p-4`):
```tsx
<div className="tile-pop flex flex-col gap-3 rounded-lg bg-(--surface-1) p-4"
     style={{ boxShadow: "var(--shadow-md)", border: "1px solid var(--border-hairline)" }}>
```
Label = the established eyebrow (`text-xs font-medium uppercase tracking-wide text-(--text-muted)`). Value = `font-data text-2xl font-semibold` + unit in `text-xs text-(--text-muted)`, mirroring `ScoreMeter`'s center treatment. Icon well reuses the exact `PanelShell.tsx:55-72` recipe (`h-9 w-9 rounded-lg`, `var(${colorVar}-ink)` on a 14% `color-mix` wash). Delta line pairs an arrow icon with the number so direction is not color-alone.

### `frontend/components/StatStrip.tsx` — `"use client"`
`grid gap-3 sm:grid-cols-2 xl:grid-cols-4`; degrades to `sm:grid-cols-2` when the report has no amenity sections (they are optional in `lib/types.ts:104-115`).

| Tile | Value | Source |
|---|---|---|
| Liveability | worst building/block score + band | `overallBand` / `BAND_LABEL` (`lib/score.ts`) |
| Access | worst amenity score + band | same; omitted when no amenity sections |
| Block complaints · 12 mo | total + YoY % | `reportMetrics.yoyDelta` over the cached block trend |
| Nearest subway | `formatWalk(meters)` + station name | `lib/amenities.ts`; falls back to `nearestMetric()` when `subway.meters` is null (Staten Island) |

The volume tile is its own `VolumeTile` client leaf owning the `useTrend(coords, "block")` subscription, so the other three do not re-render when the series lands (rule `rerender-defer-reads`). It hits an already-warm cache and `useSWRImmutable` dedupes it against the panel's own `useTrend` (rule `client-swr-dedup`).

### `frontend/components/ScoreRadar.tsx` — server component, hand-rolled SVG
No chart library — `TrendSparkline.tsx` and `ScoreMeter.tsx` are both hand-authored SVG, and a dependency in a 4-package `package.json` is not worth one chart (rule `bundle-`).

- `viewBox="0 0 260 240"`, center `(130, 112)`, max radius `88`, axis count from `axes.length`. Five today, six with walkability — both inside the 5–8 axis range the chart guidance gives, with a single dataset, its safe case.
- Static geometry (rings, spokes, label anchors) hoisted to module scope (rule `rendering-hoist-jsx`); coordinates rounded to 1dp (rule `rendering-svg-precision`).
- Rings at 25/50/75/100 in `var(--gridline)`. **The 50 ring is dashed, stroked `var(--baseline)`, labelled "NYC median."** Factually correct, not decorative: `backend/src/services/scoring.js` anchors every score on `SCORE_ANCHOR_PERCENTILES = { median: 50, p90: 90 }`, so 50 *is* the citywide median. This is the report's first benchmark.
- Polygon `fill="var(--brand)" fillOpacity="0.18"`, `stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round"` (chart guidance: single dataset ≈20% fill, full-opacity border). Vertices `r="3.5"` filled with each axis's own `var(${colorVar}-ink)`.
- **Degenerate-zero guard:** clamp plotted radius to ≥6% of max so a 0 does not collapse the polygon to a point. Comment it.
- A11y (guidance requires a non-visual fallback and forbids color-alone): `role="img"` + `aria-label` summarising every axis, plus a **visible** legend below — one row per axis with color dot, label, and score in `font-data`. The legend is the data table; it is not `sr-only`.
- Render only when `axes.length >= 3`; a 2-axis radar is meaningless. Card wrapper is the standard `rounded-lg bg-(--surface-1) p-5 sm:p-6` + `var(--shadow-md)` + hairline, eyebrow "Neighborhood profile".

### `frontend/components/WindowPills.tsx`
**Extraction, not new UI.** Move the `role="radiogroup"` pill group out of `TrendSection.tsx` (~L90-140) verbatim — arrow-key roving tabindex, `min-w-7` sizing, `font-data` numerals intact. `TrendSection` and `ReportToolbar` both import it. One implementation, one a11y behavior.

### `frontend/components/ReportToolbar.tsx`
No `"use client"` of its own — a leaf under `ReportBody`, inherits (rule *push Client Components down*).
- `sticky top-16 z-30`, below the app header (`h-16`, `z-40`), consistent with the z-ladder documented in `globals.css`. `bg-(--background)/85 backdrop-blur` + `border-b border-(--border-hairline)`, negative-margin bleed to span the container gutter.
- Left: `<h1 className="font-display text-xl font-semibold sm:text-2xl">{address}</h1>` + a `text-xs text-(--text-muted)` window-scope sub-line.
- Right: `<WindowPills>` + the "Compare with another" pill moved down from `ReportView.tsx:96-104` unchanged.

### `frontend/components/ActivitySpine.tsx` — `"use client"`
The screenshot's "Process Tracking" column, as a cross-tier chronological feed. **Replaces** the per-panel `RecentComplaintsList` sections rather than duplicating them.

- Merges `panels.buildingHealth.complaints.data` + `panels.blockQuality.complaints.data`, tags each row with its tier's `colorVar` from `lib/categories.ts`, filters to the selected window via `monthsAgoISO`, sorts newest-first, shows 8.
- Row: date rail `w-14 shrink-0 font-data text-[11px] text-(--text-muted)`; a `w-px bg-(--gridline)` spine with an `h-2 w-2 rounded-full` dot in the tier color; label `truncate text-sm text-(--text-primary)`; status sub-line `text-xs` in the matching `var(--status-*-ink)` via `STATUS_VAR` (`lib/score.ts`). `min-h-11` touch target.
- Rows open the existing `ComplaintDetailModal`; footer carries two tier-scoped "Browse all" buttons into `ComplaintsBrowserModal`. Both reuse `RecentComplaintsList.tsx:19-32`'s `dynamic(..., { ssr: false })` + `preloadBrowser()`-on-hover pattern (rules `bundle-dynamic-imports`, `bundle-preload`).
- Rows get `class="activity-row"` → `content-visibility: auto` (rule `rendering-content-visibility`).
- Skeleton while loading, height-matched, reusing the `animate-pulse rounded-md` on `--surface-2` from `ScorePanelCard.tsx:148-152`.
- **Constraint to honor:** `lib/types.ts:198-203` records that `TimelineEvent`/`ComplaintTimeline` were deliberately deleted because 311 publishes no per-case change log. This is a chronological feed of distinct complaints, **not** a per-case progress timeline. Put that distinction in a comment at the top of the file so it is not re-deleted.

---

## Modified files

### `frontend/components/PanelShell.tsx` — add `compact?: boolean`
One shell, not two. In compact mode: `p-4` instead of `p-5 sm:p-6`, `gap-4` instead of `gap-5`, and the `<ScoreMeter size={96}>` in the meter row (`:74-91`) swaps for a score chip (`font-data text-xl font-semibold` in `var(${colorVar}-ink)` + `/100` in `text-xs`). Header, icon well, title, description, `StatusBadge`, the low-confidence callout, the summary slot, and `{children}` are all identical. This is what keeps the amenity cards' description, badge, and confidence callout without writing a second card component.

### `frontend/components/AmenityPanelCard.tsx`
Pass `compact` to `PanelShell`. Nothing else changes — `AmenityMetricRows` stays, all nine rows stay visible. Optionally surface `bucketConfidence` (`lib/types.ts:89`, zero UI consumers today) as a small caveat when a bucket has `meters === null`.

### `frontend/components/ReportBody.tsx` — the restructure
This is where the section order lives (`:80-135`), so it is the main edit.
1. Lift the window: `const [months, setMonths] = useState<TrendWindow>(TREND_DEFAULT_MONTHS as TrendWindow)`, moved up from `ScorePanelCard.tsx:66-68`. Wrap the setter in `startTransition` and feed the charts `useDeferredValue(months)` so the pill responds instantly while both sparklines re-slice (rules `rerender-transitions`, `rerender-use-deferred-value`).
2. Keep `windowTotal` per-panel (`ScorePanelCard.tsx:72`). The comment there explains why the array is not lifted; that reasoning still holds and only `months` moves.
3. Grid classes replacing `:75-78`: bento row `mt-4 grid gap-4 xl:grid-cols-4` with radar and spine each `xl:col-span-2`; amenity row from the `AMENITY_COLS` lookup above. The complaint grid keeps `lg:grid-cols-2` and its `:89-91` comment — the sparkline axis labels still collide at 640px.
4. Order: `ReportToolbar` → `VerdictBanner` → `StatStrip` → bento → complaint grid → amenity grid → `MapPanelLazy`. `rings` (`:62-73`) unchanged.
5. Column layout: toolbar and StatStrip omitted; `ActivitySpine` omitted when `panels` is undefined; radar and the amenity stack included.

### `frontend/components/ScorePanelCard.tsx`
Remove the `months` `useState`; accept `months: TrendWindow` as a prop. Remove the "Recent complaints" section (`:138-166`) — it becomes `ActivitySpine`; the `recentComplaints` props move to `ReportBody`, which forwards them to the spine. Move `monthsAgoISO` to `reportMetrics.ts`. Meter, `ComplaintBreakdownBars`, and `TrendSection` untouched.

### `frontend/components/TrendSection.tsx`
Import `WindowPills` instead of defining the group inline; make `onMonthsChange` optional. When absent (the page layout, where the toolbar owns the control), render only the "{months}-month trend" label. `useTrend`, the 24-month slice, and the skeleton stay.

### `frontend/components/VerdictBanner.tsx`
Add `showAddress?: boolean`. On the page layout the toolbar owns the `<h1>`, so the banner drops its address heading (`:160`) and leads with the verdict halves; the column layout keeps it. Removes a duplicate heading and the level skip the page has today.

### `frontend/components/ReportView.tsx`
- `<div id="main">` → `<main id="main">` (`:81`). `app/page.tsx:132` already does this; the report route has no landmark, so the skip link lands on a plain div.
- Remove the Compare link (`:96-104`); it moves into `ReportToolbar`. `AddressSearch` stays here, above the sticky bar, so it scrolls away.
- Container `py-8` → `pt-6 pb-8` so the sticky toolbar does not sit on a fat gap.

### `frontend/app/globals.css` — **additive only, zero token edits**
Append near `.card-pop` (`:309-325`):
```css
.tile-pop { transition: transform 180ms ease, box-shadow 180ms ease; }
@media (hover: hover) and (pointer: fine) {
  .tile-pop:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
}
.activity-row { content-visibility: auto; contain-intrinsic-size: 0 56px; }
```
`.card-pop`'s `translateY(-8px) scale(1.025)` is too much motion for a dense KPI tile (motion 3/10). Add `.tile-pop` to the existing `prefers-reduced-motion` block at `:351-363` alongside `.card-pop`.

### `frontend/components/icons.tsx`
Add `TrendUpIcon` and `TrendDownIcon` on the file's existing grid — `viewBox="0 0 20 20"`, `stroke="currentColor"`, `strokeWidth={1.5}`, `aria-hidden`, base class `shrink-0`, single `className?` prop. `ClockIcon`, `ScaleIcon`, `TransitIcon` already cover the rest.

---

## Not changed

Nothing in `backend/`. No changes to `lib/types.ts`, `lib/api.ts`, or `lib/hooks.ts` — the layout adds **zero** network requests. `MapPanel`, `MapPanelLazy`, `ComplaintsBrowserModal`, `ComplaintDetailModal`, `ScoreMeter`, `StatusBadge`, `ComplaintBreakdownBars`, `AmenityMetricRows`, `RecentComplaintsList`, `TrendSparkline`, `FactRotator` are untouched and reused as-is.

## Conventions to hold

Easy to lose in a layout rewrite, and several are enforced or documented in-repo:

- Shadows and borders as **inline style** with `var(--shadow-md)` + `1px solid var(--border-hairline)`, never a Tailwind class. Cards `--shadow-md`, modals `--shadow-lg`.
- `.font-data` (IBM Plex Mono, tabular-nums) on every score, count, radius, date, walk time, coordinate.
- Section eyebrow is always `text-xs font-medium uppercase tracking-wide text-(--text-muted)`.
- `rounded-lg` cards/modals · `rounded-md` skeletons, rows, callouts · `rounded-full` badges, chips, dots.
- `min-h-11` (44px) on every row and text button; `min-h-8 min-w-8` on pills.
- Colors via `text-(--token)` / `bg-(--token)` arbitrary-property syntax or inline `style` — Tailwind has no color registrations here (`@theme inline` at `globals.css:205-211` maps only background/foreground/fonts). Never a raw hex in a component; never an emoji as an icon.
- Z-ladder: header 40 → **toolbar 30** → search panel 50 → complaints browser 60 → detail 70.

---

## Sequencing

Each step ends with the app building and rendering.

0. Rewrite `PLAN.md` at the repo root with this plan. The current file is the shipped amenity design record — preserve it as `PLAN-amenities.md` rather than losing it.
1. `lib/reportMetrics.ts`; move `monthsAgoISO` out of `ScorePanelCard`. No visual change.
2. `WindowPills.tsx` extraction; `TrendSection` optional `onMonthsChange`. No visual change.
3. Lift `months` into `ReportBody` and thread it down. Control still renders per-panel.
4. `PanelShell` `compact` + `AmenityPanelCard` passes it. Amenity row gets shorter; all rows still visible.
5. `StatTile` + `StatStrip` + the two icons.
6. `ScoreRadar`.
7. `ActivitySpine`; remove the "Recent complaints" section from `ScorePanelCard` and rewire the props.
8. `ReportToolbar` + `globals.css` additions + `ReportView` / `VerdictBanner` heading changes; assemble the bento and the `AMENITY_COLS` lookup.
9. Responsive, contrast, and keyboard pass.

## Verification

```bash
cd frontend
yarn lint
yarn build                       # must stay clean; watch the /report First Load JS number
node scripts/check-contrast.mjs  # existing checker — must pass in both themes
```

With `cd backend && yarn dev` and `yarn dev` in `frontend`, on `/report?address=123%20Ludlow%20St`:

- **Layout** at 375 / 768 / 1024 / 1440. No horizontal scroll at any width; one column at 375.
- **`/compare`** with two addresses — the columns must still read with the radar added and the toolbar/StatStrip absent. Most likely regression.
- **Global window** — changing it updates both sparklines and the activity spine together; the pill stays responsive while they re-slice.
- **No duplicate complaints** — confirm the page lists each recent complaint once, in the spine, and that both "Browse all" buttons open `ComplaintsBrowserModal` scoped to the right tier and radius.
- **Amenity cards** — all nine metric rows visible without interaction; description, badge, and confidence callout all still present.
- **Radar** — dashed 50 ring labelled "NYC median"; visible legend lists every score; test a low-scoring address to exercise the zero clamp. Temporarily add a 6th axis to confirm the hexagon renders before walkability is real.
- **YoY tile** — cross-check against the 24-month sparkline; confirm a *drop* in complaints renders green with a down arrow.
- **Amenity-less report** — force the three amenity sections to `undefined` in the SWR response: strip drops to 2 tiles, radar suppresses itself, amenity row does not render.
- **Staten Island address** — `subway.meters === null`; the nearest-subway tile must fall back, not print "null".
- **Keyboard** — Tab through toolbar → pills (arrow keys) → tiles → spine rows → panels; focus ring visible everywhere and never hidden behind the sticky bar (add `scroll-margin-top` if it is).
- **Themes** — light / dark / system; check the toolbar's `backdrop-blur` background, the radar gridlines, and the delta inks in both.
- **Reduced motion** — `.tile-pop` and the meter transition neutralised with the OS setting on.
