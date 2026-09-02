# Frontend — `lib/`

The non-UI core: the API client, the SWR data-fetching hooks, Google
credentials, scoring/formatting helpers, and shared types.

---

## `api.ts` — client for the Express backend + same-origin API routes

Every network call the app makes to something other than same-origin route
handlers goes through here. `API_BASE_URL` (`NEXT_PUBLIC_API_BASE_URL`,
defaulting to `http://localhost:3001`) is the Express backend's origin; a
trailing slash is stripped because a doubled `//` gets redirected by
Vercel's edge in a way that strips CORS headers.

- **`getLatLng(address, placeId?)`** — geocodes via the app's own
  `/api/geocode` route. Tries a `placeId` lookup first when given one,
  otherwise free-text; on a zero-result free-text lookup, retries once with
  unit designators stripped (`stripUnit()` — apt/unit/suite/floor/room/#),
  since a unit-suffixed address can fail to geocode even though the building
  itself resolves fine.
- **`fetchReport(lat, lng)`** — `POST /api/score`. **No mock fallback on any
  failure** — a network error or non-2xx throws a renter-readable message
  (a 503 gets its own "NYC's data service is unavailable" copy). A
  working-looking report is proof the backend answered.
- **`fetchNearbyComplaints`** / **`fetchComplaintGroups`** / **`fetchGroupDetail`**
  — the three complaint-listing calls, matching the backend's raw/grouped/
  drill-in modes (`GET /api/complaints`, `?complete=1`, `GET /api/complaints/group`).
  `tier` is required on all three — omitting it lets the higher-volume tier's
  types crowd the row cap and starve the other tier's list.
- **`fetchTrend`** — `GET /api/trend`. Always requests the full
  `TREND_MAX_MONTHS` (24) span and lets the caller slice down
  (`lib/reportMetrics.ts#sliceWindow`), since every shorter window is a
  suffix of the 24-month one — one request answers all six selectable
  windows.
- **`fetchExplanation(lat, lng, tier)`** — the slow AI path. Only ever called
  for `tier: "overall"` in practice (see `lib/hooks.ts#useExplanation`).
  Returns `null` on any failure or when the backend answered with
  `explanationSource: "template"` — callers treat `null` as "keep the
  deterministic copy," so this never throws.
- **`fetchShowcase(mode, limit, init?)`** — `GET /api/showcase`, cache-only on
  the backend so this is fast or empty, never slow; still wrapped in a 2.5s
  client-side timeout to bound how badly a backend cold-start or Mongo outage
  could stall a page render. Returns `{ items: [], fallback: null }` on any
  failure.
- **`fetchAmenityNearby(lat, lng, tier, bucket)`** — `GET /api/amenities/nearby`,
  backs the amenity "see all instances" browser.
- **`fetchSuggestions(query, signal?)`** — same-origin `/api/autocomplete`;
  doesn't need `API_BASE_URL`.

---

## `hooks.ts` — the app's data layer, on SWR

Every fetch above is wrapped in a `useSWRImmutable` (or, for autocomplete,
plain `useSWR`) hook here rather than called directly from a component. Three
things this buys over the hand-rolled `useEffect`+`useState` pattern it
replaced:

1. **Dedup** — two `ScorePanelCard`s, two compare columns, or several
   components asking for the same key share one in-flight request.
2. **No waterfall** — each hook fires as soon as *its own* inputs exist,
   rather than waiting for an unrelated fetch above it to finish first (see
   `ReportView`'s doc comment for the before/after request-order diagram).
3. **No manual staleness tagging** — SWR's keys structurally prevent a
   previous address's results from rendering under a new one, replacing a
   hand-rolled `{ key, items }` pairing that existed for the same reason.

`useSWRImmutable` everywhere except suggestions: scores/trends/complaint
histories are snapshots of a municipal dataset sitting behind a 24h
server-side cache, so revalidating on window focus would just spend a
Socrata call to redraw an identical chart. All hooks disable SWR's default
five-retry backoff (`NO_RETRY`) — a `503` means "NYC's data service is down
right now," and retrying behind the user's back replaces that message with a
spinner for the length of the backoff while hammering an upstream that just
said it was struggling.

Key hooks: `useCoords`, `useReport`, `useNearbyComplaints`,
`useTrend`/`usePrefetchTrends` (the latter uses SWR's `preload()` rather than
a second subscription, so warming the cache doesn't re-render a component
that doesn't display the data), `useExplanation` (the one hook gating a
network call on `explanationSource !== "ai"`), `useReportPanels` (the
report's one fixed-arity fanout — hand-enumerates each complaint tier
because React's Rules of Hooks forbid looping the category registry to build
hook calls; a category added to `lib/types.ts` without a matching line here
is a compile error, not a silently blank panel), `useNearbyAmenities`, and
`useSuggestions`.

---

## `maps-keys.ts` — the two Google Maps credentials

See [`frontend-architecture.md`](./frontend-architecture.md#the-two-google-maps-keys)
for the full server-key/client-key split. Also exports `mapId()` for the
Map Style ID used by `MapPanel`.

---

## `types.ts` — shared TypeScript types

Written to match the backend's response contract field-for-field.
`SectionBase` factors out what every scored section has (complaint or
amenity); `ScoreSection<TCounts>` (complaint tiers) requires `explanation`/
`explanationSource` since the backend always attaches a template inline,
while `AmenitySection<TMetrics>` (amenity tiers) inherits them as optional
since no amenity tier ever carries them on `/api/score` — the equivalent
text is always computed client-side (`lib/amenities.ts#explainAmenity`).
`ReportResponse` carries the two required complaint sections plus four
optional amenity sections (`transitAccess`, `parksAccess`, `bikeAccess`,
`walkabilityAccess` — optional because a pre-amenities showcase cache entry,
or a server-side dataset-load failure, can omit any of them).

`AmenityMetric.routes?: string[]` is present only on `transit.subway`/
`transit.bus` — every consumer must check the bucket before reading it, not
assume it's always an array.

**The per-complaint status-change timeline (`TimelineEvent`/`ComplaintTimeline`)
does not exist in this codebase at all** — it was removed, not stubbed out,
because 311 publishes a complaint's current status and no change history, so
every intermediate "event" was synthesized client-side (and, for recently
filed complaints, dated into the future). A one-line comment at the bottom of
this file marks where they used to live; nothing renders or expects them.

---

## `score.ts` — display logic derived from a report

- **`bandForScore` / `BAND_LABEL` / `BAND_VAR` / `BAND_VERDICT`** — the
  complaint-tier band vocabulary (good/fair/poor) and its display strings/
  CSS variables. **`ACCESS_VERDICT`** is the parallel amenity vocabulary
  (excellent/typical/carDependent) — deliberately separate copy, since
  "fair" reads as a complaint about a place while an amenity band is a
  distance fact.
- **`overallBand(...bands)`** / **`overallAmenityBand(...bands)`** — worst
  band across any number of sections, one per vocabulary (variadic, so
  passing 2, 3, or 6 sections all work; zero args returns the vocabulary's
  best band, the correct identity for a worst-of fold).
- **`meanScore(...scores)`** — plain rounded mean, the headline number for a
  multi-section summary (Liveability, Access).
- **`STATUS_LABEL` / `STATUS_VAR`** / **`CATEGORY_LABEL`** — shared display
  strings for `ComplaintStatus` and each complaint bucket key, so
  `ActivitySpine`, `ComplaintDetailModal`, `ComplaintsBrowserModal`, and the
  breakdown bars can't drift apart on wording.
- **`compareToBaseline(buildingCounts, blockCounts, windowMonths)`** — how
  this address's counts compare to the citywide baseline
  (`lib/citywide-baseline.ts`), scaled by `windowMonths / 24`.
- **`explainVerdict(complaintSections, overall, windowMonths)`** — the
  one-line "why this rating" sentence for the Liveability half of
  `VerdictBanner`: the top 1–2 complaint categories that actually drove the
  overall band, plus how many of those are still open/in-progress.
- **`explainAccess(amenitySections, overall)`** — the Access-half
  equivalent: leads with whichever amenity tier set the band, and within it
  names the single nearest amenity — the one detail in the summary a reader
  can independently verify on a map.
- **`CONFIDENCE_MESSAGE`** — user-facing copy per backend `confidenceReason`
  value (`stale_baseline_radius` deliberately has none — that's a backend
  misconfiguration to flag to the team, not something to show a renter).

There is no client-side trend-bucketing function any more
(`buildMonthlyTrend` was removed) — `/api/trend` does the month bucketing
server-side now, which is truncation-proof in a way a client-side fold over
a row-capped complaint list could never be.

---

## `amenities.ts` — amenity display helpers

- **`AMENITY_BUCKET_LABEL`** — display label per bucket, across all four
  tiers (subway, bus, rail, park, playground, garden, bikeShare, bikeLane,
  protectedLane, grocery, restaurant, cafe, school).
- **`formatDistance(meters)`** / **`formatDistanceRange(metersList)`** — the
  one place any raw distance converts from meters (every internal
  computation's native unit) to the imperial units the UI shows ("70 ft" /
  "0.3 mi"). Never format a distance ad hoc at a call site.
- **`formatWalk(meters)`** / **`formatWalkRange(metersList)`** — meters to an
  estimated walk time in minutes (`AMENITY_WALK_METERS_PER_MIN` on the
  backend, mirrored here as a constant so no component invents its own
  conversion). The `...Range` variants collapse to the single-value form
  when every value in the set rounds to the same display number (e.g. a
  tightly-clustered subway complex's several entrances).
- **`nearestMetric(metrics)`** — the nearest of a tier's buckets by distance
  (never by `within`, which is display-only), used by the panel summary
  line, `explainAccess`, and `computeOverviewMetrics`.
- **`explainAmenity(label, score, metrics)`** — the amenity-tier "Why this
  score?" text, computed **entirely client-side** (no AI, no backend call) —
  mirrors the backend's own `templateAmenityExplanation.js` ("nearest across
  every bucket") logic exactly, using the same `nearestMetric` the panel's
  own summary line already uses, so the two can't disagree about which
  amenity is nearest.

---

## `categories.ts` — the report's six categories

`COMPLAINT_CATEGORIES` (Building Health, Block Quality) and
`AMENITY_CATEGORIES` (Transit/Parks/Bike/Walkability Access) as two
separately-typed const arrays rather than one list filtered by `kind` —
filtering a merged list would widen back to the union type and lose the
per-kind narrowing `ScorePanelCard`/`AmenityPanelCard`'s props need. Each
entry carries its `ReportResponse` key, its wire `CategoryId`, a color
token, and a map-ring label. `RADAR_LABEL` is a separate, deliberately
*total* `Record<CategoryKey, string>` of short axis labels for
`ScoreRadar` — a category added to `categories.ts` without a matching radar
label is a build error, not a wrapped label at runtime.

---

## `reportMetrics.ts` — derived report-level numbers

- **`sliceWindow` / `windowTotal`** — slice a 24-month trend series down to
  a shorter window and sum it.
- **`yoyDelta(points)`** — year-over-year change (last 12 months vs. the 12
  before), `null` unless the full 24-month series is available. Polarity is
  inverted from the usual convention: these are complaint counts, so a
  *negative* percent is the good outcome — callers must map `pct < 0` to the
  "good" color, not the reverse.
- **`computeOverviewMetrics(report)`** — the single pure fold both
  `VerdictBanner` and `OverviewHeader` call to get the Liveability/Access
  bands+scores and the nearest-transit summary, so the two components can't
  independently recompute it and drift, which is how an earlier version
  split into two disagreeing implementations. The function itself takes no
  hooks (a synchronous fold over data already in hand); each caller wraps
  its own call in `useMemo(() => computeOverviewMetrics(report), [report])`
  since `report` is a stable SWR cache identity.

---

## `citywide-baseline.ts` — the homepage's offline-safe baseline

A **copy** of `backend/src/config/baseline.json` (the committed output of
`npm run baseline`), not a fetch. Backs `CitywideBaselinePanel` and
`lib/score.ts#compareToBaseline`. Copied deliberately: this is what the
homepage falls back to when the score cache is cold, so it cannot itself
depend on the backend being reachable — but it's real measured data either
way, not a placeholder. **Must be re-copied by hand if the backend's
baseline is ever rebuilt**, or the homepage describes an older city than the
live scores do.

---

## `seed-addresses.ts` — real addresses, offline autocomplete fallback

What remains of the old `mock-data.ts` after the fabricated-report generator
was removed entirely. Holds a small set of real NYC addresses with real
coordinates, used only by `app/api/autocomplete/route.ts#findSuggestions()`
as the offline fallback when no Google Places key is configured or the live
call fails. Independent from the backend's own curated showcase list
(`backend/src/config/showcase.js`) by design — one drives an offline search
box, the other drives what gets pre-warmed from Socrata.

---

## `record-lookup.ts` — server-only showcase write

`recordLookup(address, lat, lng)`, called only from
`app/api/geocode/route.ts`'s `placeId` branch. Forwards to the backend's
`POST /api/lookups` with the shared `INTERNAL_API_SECRET` (never
`NEXT_PUBLIC_`-prefixed, so it never reaches the client bundle). Never
throws — a failed write costs the homepage one directory row, and must never
turn into a failed report for the person who triggered it.

---

## `nyc-facts.ts` / `renting-facts.ts` — loading-screen trivia

Two deliberately separate hardcoded string lists consumed by `FactRotator`:
`NYC_FACTS` for waits that happen *after* a search (the report itself, the
complaints browser), `RENTING_FACTS` for the homepage's hero card fill-in,
which happens before anyone has searched anything — showing the same trivia
in both places would make the homepage look like it's loading a report it
isn't. Both are hardcoded rather than fetched, since a screen whose entire
job is covering for latency must not introduce a second thing that can be
slow.

---

## `theme.ts` — resolved-theme state

`THEME_INIT_SCRIPT` (inlined into `<head>` by `app/layout.tsx`, runs before
hydration) and a shared `MutationObserver`-backed external store
(`subscribeResolvedTheme`/`getResolvedTheme`) for anything that needs to
*react* to theme changes at runtime (`MapPanel` swapping its vector style,
`ThemeToggle` itself) — one observer shared across every subscriber, since
the compare page can mount two `MapPanel`s that would otherwise each start
their own.

---

## `lru.ts` — server-only TTL cache

`TtlCache<V>`, a ~30-line capacity+TTL map (not the `lru-cache` npm package —
unnecessary for what's needed) used by `api/geocode` and `api/autocomplete`
to avoid re-billing Google for a repeat request within a process's lifetime.
Scoped to one serverless instance's module graph — a cold instance costs
latency, never correctness, since both callers re-fetch cleanly on a miss.

---

## `useDialog.ts` — shared modal accessibility

A hook (not a component) giving any dialog panel Escape-to-close, a focus
trap (Tab cannot leave the panel), body-scroll lock, and focus restoration
to whatever opened it — extracted after `ComplaintDetailModal` originally
had only the Escape handler and a second dialog would have duplicated the
gap. Used by every full-screen modal in the app.
