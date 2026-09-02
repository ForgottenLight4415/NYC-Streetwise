# Project documentation

Module-by-module reference for the whole codebase, written by reading the
actual source — each doc says what a module or feature does, how it's
called, and the non-obvious decisions baked into it. This is reference
documentation at the feature/module level, not a catalog of every individual
component or function — for that, read the source next to whichever doc
brought you there.

For setup instructions, start with the [root README](../README.md) instead —
these are reference docs, not a getting-started guide.

**Configuration split, if that's what you're here for:** Mongo is dev (local
Docker) vs prod (Atlas) — [`backend-providers.md`](./backend-providers.md#mongojs--connection-management).
Google Maps is two keys, server vs browser —
[`frontend-architecture.md`](./frontend-architecture.md#the-two-google-maps-keys).

## Backend (`backend/`)

1. [`backend-architecture.md`](./backend-architecture.md) — layering, request
   lifecycle, app wiring, entry point, core design principles
2. [`backend-routes.md`](./backend-routes.md) — every HTTP endpoint (9 route
   modules — score, complaints, trend, showcase, amenities, explanation,
   health), request/response shapes, error codes
3. [`backend-services.md`](./backend-services.md) — orchestration, the
   percentile scoring algorithm (shared by complaint and amenity tiers), and
   the deterministic + AI explanation layer
4. [`backend-providers.md`](./backend-providers.md) — the Socrata client,
   Mongo cache, baseline loaders, the static amenity datasets, Google
   Routes/Places, and the AI adapters
5. [`backend-config-and-scripts.md`](./backend-config-and-scripts.md) — every
   tunable constant, plus the offline CLI scripts

See also [`backend/CLAUDE.md`](../backend/CLAUDE.md) — the data modeling
decisions log: why each complaint type is in or out, known data caveats like
`streetCondition`'s null-geocode rate, and the full API contract.

## Frontend (`frontend/`)

1. [`frontend-architecture.md`](./frontend-architecture.md) — pages, API
   routes, data flow, styling approach
2. [`frontend-components.md`](./frontend-components.md) — components grouped
   by feature area (search, report, amenities, compare, complaints browser,
   landing page)
3. [`frontend-lib.md`](./frontend-lib.md) — the API client, scoring/
   formatting helpers, and the amenity/category helpers

See also [`frontend/CLAUDE.md`](../frontend/CLAUDE.md) for frontend
conventions and data-flow notes.

## The one thing worth reading before anything else

The root README's
["What's real vs. mocked"](../README.md#whats-real-vs-mocked-right-now)
table is the current answer to "is what I'm looking at real." All six scores,
the complaints browser, the trend chart, and the homepage's sample reports
are real. The only thing this app deliberately does not show is a
per-complaint status-change history — 311 does not publish one.
