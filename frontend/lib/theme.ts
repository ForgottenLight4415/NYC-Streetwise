export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "streetwise.theme";

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === "system" || v === "light" || v === "dark";
}

/**
 * Runs before first paint, inlined into <head> by app/layout.tsx — a stylesheet
 * alone can't do this, because the stored preference has to beat the OS media
 * query, and React hasn't hydrated yet.
 *
 * `data-theme` on <html> always holds the *resolved* value ("light"/"dark"),
 * never "system"; the preference itself stays in localStorage. That keeps
 * globals.css down to a single `[data-theme="dark"]` block with no third case.
 *
 * Kept as a string so it can be injected verbatim, and deliberately tiny: it
 * blocks paint. Any throw (Safari private mode denying localStorage) falls
 * through to the light theme rather than leaving the page unstyled.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});
if(p!=="light"&&p!=="dark"&&p!=="system")p="system";
var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.setAttribute("data-theme",d?"dark":"light");
}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

/* ---------------------------------------------------------------------------
   The resolved theme as an external store.

   `data-theme` on <html> is the single source of truth (the init script above
   sets it, ThemeToggle updates it), but anything that needs to REACT to it was
   observing the attribute for itself. MapPanel ran its own MutationObserver —
   and the compare view mounts two MapPanels, so that was two observers on the
   same node for the same attribute.

   One observer, shared, created on first subscription and torn down with the
   last.

   Consumed with useState + subscribe rather than useSyncExternalStore, because
   the server snapshot would have to answer "light" and MapPanel cannot survive
   a light->dark correction after mount — see the comment there.
   --------------------------------------------------------------------------- */

const themeSubscribers = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

export function subscribeResolvedTheme(onChange: () => void): () => void {
  themeSubscribers.add(onChange);

  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      // Copied: a subscriber unmounting in response can mutate the set.
      for (const notify of Array.from(themeSubscribers)) notify();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }

  return () => {
    themeSubscribers.delete(onChange);
    if (themeSubscribers.size === 0) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
}

export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}
