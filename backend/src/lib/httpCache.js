/**
 * Response cache headers, for the GET endpoints whose answers outlive the
 * request that asked for them.
 *
 * WHY THIS EXISTS. Nothing in this API used to send a Cache-Control header at
 * all, so every repeat request cost a serverless invocation plus at least one
 * Atlas round trip to re-derive a byte-identical answer. The Mongo caches
 * already stop us re-asking Socrata and Google; these stop us re-running the
 * function.
 *
 * THE RULE FOR ADDING ONE. A response may only be cached here if it is a pure
 * function of the URL over the chosen window. Three things in this codebase
 * are NOT, and each is deliberately left uncached:
 *
 *   - GET /api/showcase picks its `fallback` at random on EVERY call and
 *     offers a `mode=random` sort. Caching it would quietly freeze both. Its
 *     only caller (the homepage) already pins it for 300s with Next's own ISR
 *     `revalidate`, so a CDN header would buy close to nothing and cost the
 *     randomness that is the point.
 *   - GET /api/amenities/nearby?tier=walkability is served CACHE-ONLY from
 *     whatever Places result /api/score last wrote. A cold coordinate answers
 *     `instances: []` and becomes populated as soon as a report is built for
 *     it, so an edge-cached empty array would outlive the emptiness it
 *     describes. Only the three static-dataset tiers are cacheable.
 *   - POST /api/score cannot be edge-cached at all: it is a POST. (Its body
 *     IS a pure function of the coordinate — buildScoreReportInternal keeps
 *     wall-clock values out of the payload specifically so repeat calls stay
 *     byte-identical — so a GET alias would be cacheable. That is a separate
 *     decision, not something to smuggle in here.)
 *
 * `Vary: Origin` is already set globally in app.js, so a shared cache keys
 * these per requesting origin rather than serving one origin's CORS headers
 * to another.
 */

/**
 * Seconds a shared (CDN) cache may serve a response before revalidating, and
 * how long it may keep serving the stale copy while it does.
 *
 * `public` rather than `private`: none of these responses is per-user. Nothing
 * in this API is authenticated except the two cron endpoints, which are not
 * cached.
 *
 * `max-age=0` keeps BROWSERS revalidating while letting the CDN serve from
 * its own copy. The browser layer is already handled better than a timer can:
 * the frontend holds reports in SWR under `useSWRImmutable`, so a second view
 * of the same address does not re-request at all. What we want from the edge
 * is to absorb the FIRST request from every other visitor.
 */
export function cacheFor({ sMaxAge, staleWhileRevalidate }) {
  return `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}`;
}

const DAY = 24 * 60 * 60;

/**
 * Amenity instance lists for the three STATIC tiers (transit/parks/bike).
 *
 * A week is long because the data behind it is rebuilt by
 * `yarn build:amenities` on a scale of years. The one bucket that really
 * moves is bike-share, refreshed by the monthly `GET /api/refresh-amenities`
 * cron — so the worst case this introduces is a newly-opened Citi Bike dock
 * taking up to a week longer to appear in a list it was already going to wait
 * up to a month for.
 */
export const AMENITIES_NEARBY_CACHE = cacheFor({
  sMaxAge: 7 * DAY,
  staleWhileRevalidate: 30 * DAY,
});

/**
 * The trend series, which already sits on a 24h Mongo cache — so an hour at
 * the edge adds at most an hour of staleness to data that may already be a
 * day old, and saves the invocation plus the Atlas read.
 *
 * Not longer than an hour because the series is labelled by calendar month
 * relative to `now`: at a month boundary the bucket labels shift, and an hour
 * bounds how long a stale label can survive.
 */
export const TREND_CACHE = cacheFor({ sMaxAge: 60 * 60, staleWhileRevalidate: DAY });

/**
 * Health must never be cached. A cached 200 is exactly the failure a health
 * check exists to catch — it would report a recycled or wedged instance as
 * fine for as long as the entry lived.
 */
export const NO_STORE = "no-store";
