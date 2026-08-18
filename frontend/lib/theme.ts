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
