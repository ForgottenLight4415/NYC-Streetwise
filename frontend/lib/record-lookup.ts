// Server-side only. Records that a user opened a report for a real, picked
// address, so the homepage can name a cached coordinate later.
//
// WHY THIS LIVES ON THE SERVER. The address string this sends is the one the
// homepage later shows to every visitor, from a public site. If the browser
// supplied it, the backend would have to guess whether an arbitrary string was a
// genuine address — which is a blocklist, and blocklists only stop the phrasings
// someone already thought of. Instead the string never leaves our own
// infrastructure untrusted: the geocode route asks Google to resolve a Places
// suggestion the user picked, takes `formattedAddress` straight from that
// response, and forwards it here with a shared secret the browser never sees.
//
// INTERNAL_API_SECRET is deliberately NOT prefixed NEXT_PUBLIC_. A NEXT_PUBLIC_
// variable is inlined into the client bundle at build time, which would publish
// the credential to every visitor and undo the whole design.

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001").replace(
  /\/+$/,
  ""
);

/** How long to wait before giving up. Nothing user-facing depends on this call. */
const TIMEOUT_MS = 2000;

/**
 * Awaited by its caller through `after()`, so the request genuinely completes
 * after the response is sent rather than being abandoned mid-flight — an earlier
 * version left the promise floating and the write silently never landed.
 *
 * Never throws. Its failure is invisible to the person whose geocode triggered
 * it: a missing directory row costs the homepage one card it could have shown,
 * while a geocode that failed because a bookkeeping write failed would cost
 * someone their report.
 */
export async function recordLookup(address: string, lat: number, lng: number): Promise<void> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return;

  await fetch(`${API_BASE_URL}/api/lookups`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ address, lat, lng }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});
}
