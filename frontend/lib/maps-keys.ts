/**
 * Google Maps credentials — two keys, deliberately not interchangeable.
 *
 * Google restricts a key by *caller*, and the two callers here are different
 * kinds of thing, so one key cannot be locked down for both:
 *
 * | Key                      | Called from                | Google restriction    |
 * |--------------------------|----------------------------|-----------------------|
 * | `GOOGLE_MAPS_API_KEY`    | our server (route handlers)| IP addresses          |
 * | `GOOGLE_MAPS_CLIENT_KEY` | the browser (Maps JS SDK)  | HTTP referrers        |
 *
 * The client key is *published* — it ships inside the `<script src>` in
 * `app/layout.tsx` and is readable by anyone viewing source. That is normal and
 * unavoidable for the Maps JavaScript API; referrer restrictions plus per-key
 * quotas are what contain it.
 *
 * The server key must never reach the browser. It carries Geocoding and Places
 * quota that is billed per request and has no referrer to restrict it by, so
 * `serverMapsKey()` is only ever read inside route handlers. There is
 * intentionally **no fallback from one to the other** — a fallback is how a
 * billed server key ends up in page source.
 *
 * Both are read at call time rather than module scope so a key added to
 * `.env.local` mid-session is picked up on the next request, not the next
 * restart.
 */

/**
 * Key for server-side Google calls: Geocoding API + Places API (New).
 * Used by `app/api/geocode` and `app/api/autocomplete`. Never render this.
 */
export function serverMapsKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY || undefined;
}

/**
 * Key for the browser-loaded Maps JavaScript API (maps, marker, places
 * libraries). Safe to embed in HTML — restrict it by HTTP referrer in the
 * Google Cloud console.
 *
 * `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is accepted as a legacy alias because it
 * was already a public-by-design variable; the private key is not accepted.
 */
export function clientMapsKey(): string | undefined {
  return (
    process.env.GOOGLE_MAPS_CLIENT_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    undefined
  );
}

/**
 * The `<script>` URL for the Maps JS SDK, or `null` when no client key is set.
 *
 * `loading=async` opts into Google's non-blocking bootstrap and silences the
 * console warning about direct loading. It means the SDK is not guaranteed to
 * exist by the time React hydrates, so `MapPanel` waits for `window.google`
 * rather than assuming it — see `whenMapsReady` there.
 *
 * `places` dropped from `libraries=`. It is never used in the browser at all —
 * autocomplete runs server-side through /api/autocomplete against the server
 * key — so the bootstrap was fetching a library nothing consumes.
 *
 * `maps,marker` are kept even though `MapPanel` also calls `importLibrary` for
 * both. Removing the parameter entirely ought to work, and probably does, but
 * this environment has no way to confirm a map actually PAINTS (the automated
 * browser window is permanently backgrounded, and Google's vector renderer
 * produces an empty container in a hidden tab), so the unverifiable half of the
 * change was left alone and only the certain half taken.
 */
export function mapsScriptSrc(): string | null {
  const key = clientMapsKey();
  return key
    ? `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=maps,marker&loading=async`
    : null;
}

/**
 * Map ID for the vector-rendered map in `MapPanel`, created in Map Management
 * in the Google Cloud console and used to attach a cloud-based style (the
 * Maps JS API rejects a `styles` array on any map that also sets `mapId`).
 * Read via `NEXT_PUBLIC_*` since it's needed in the browser, same as the
 * client key.
 */
export function mapId(): string | undefined {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || undefined;
}
