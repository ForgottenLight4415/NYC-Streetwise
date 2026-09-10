import { clearRecentSearches } from "./recentSearches";

// Cookie/localStorage consent, for the one non-essential thing this app
// stores locally: recent searches (see lib/recentSearches.ts). Theme
// preference (lib/theme.ts) is NOT gated here — it carries no personal data
// and exists purely to avoid a flash of the wrong theme before paint, so it
// is treated as strictly-necessary/functional storage. See app/cookies for
// the plain-language explanation of that split.

export type ConsentChoice = "accepted" | "declined";

const CONSENT_KEY = "streetwise.cookieConsent";
const CONSENT_EVENT = "streetwise:consentchange";
// Separate from CONSENT_EVENT: reopening the banner to let someone change
// their mind is not itself a change of the stored choice, so it must not be
// conflated with "undecided" (getConsent() === null) on first render.
const REOPEN_EVENT = "streetwise:consentreopen";

export function getConsent(): ConsentChoice | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(CONSENT_KEY);
    return stored === "accepted" || stored === "declined" ? stored : null;
  } catch {
    return null;
  }
}

export function setConsent(choice: ConsentChoice) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Private browsing refuses writes; the banner will simply reappear next
    // visit, which is the correct degrade (no consent recorded, none assumed).
  }
  // Covers both a fresh Decline and revoking a prior Accept.
  if (choice === "declined") clearRecentSearches();
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

/** Reopens the banner without touching the stored choice — the footer's
 *  "Cookie Preferences" control calls this. */
export function reopenConsentBanner() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REOPEN_EVENT));
}

export function subscribeReopen(onReopen: () => void): () => void {
  window.addEventListener(REOPEN_EVENT, onReopen);
  return () => window.removeEventListener(REOPEN_EVENT, onReopen);
}

/* External-store trio, same SSR-safe shape as lib/recentSearches.ts: the
   server snapshot is always null (undecided), so there is no hydration
   mismatch — the banner is absent on first paint on both sides, then opens
   post-hydration if the stored choice is genuinely absent. */

export function subscribeConsent(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CONSENT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CONSENT_EVENT, onChange);
  };
}

export function getConsentSnapshot(): ConsentChoice | null {
  return getConsent();
}

export const getConsentServerSnapshot = (): ConsentChoice | null => null;
