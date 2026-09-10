// Recent address searches, stored in localStorage. Extracted out of
// AddressSearch.tsx (which is where this state used to live) so lib/consent.ts
// can clear it on Decline without importing a client component's internals.

const RECENT_KEY = "streetwise.recentSearches";
const RECENT_EVENT = "streetwise:recentschange";
const MAX_RECENT = 5;

export function getRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveRecentSearch(address: string) {
  if (typeof window === "undefined") return;
  const existing = getRecentSearches().filter((a) => a !== address);
  const next = [address, ...existing].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private browsing refuses writes; recents are a convenience, not state
    // anything else depends on.
  }
  window.dispatchEvent(new Event(RECENT_EVENT));
}

/** Called on Decline (fresh or revoking a prior Accept) — see lib/consent.ts. */
export function clearRecentSearches() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // Same private-browsing case as saveRecentSearch above.
  }
  window.dispatchEvent(new Event(RECENT_EVENT));
}

/* Recents live in localStorage, so they are subscribed to as an external store
   rather than copied into state on mount. Reading them during render instead
   would return [] on the server and a populated list on the client, which is a
   hydration mismatch. */

const EMPTY: string[] = [];

export function subscribeRecents(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(RECENT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(RECENT_EVENT, onChange);
  };
}

// Cached because useSyncExternalStore compares snapshots by identity, and
// getRecentSearches() parses fresh JSON into a new array every call — which
// would otherwise loop forever.
let recentsCache: string[] = EMPTY;
let recentsRaw: string | null = null;

export function getRecentsSnapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(RECENT_KEY);
  } catch {
    return EMPTY;
  }
  if (raw !== recentsRaw) {
    recentsRaw = raw;
    recentsCache = getRecentSearches();
  }
  return recentsCache;
}

export const getRecentsServerSnapshot = (): string[] => EMPTY;
