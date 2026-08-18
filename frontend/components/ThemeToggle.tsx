"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  isThemePreference,
  THEME_KEY,
  type ThemePreference,
} from "@/lib/theme";
import { ContrastIcon, MoonIcon, SunIcon } from "./icons";

const OPTIONS: {
  value: ThemePreference;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "system", label: "System", Icon: ContrastIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
];

/** Same-tab notification. `storage` only fires in *other* tabs. */
const CHANGE_EVENT = "streetwise:themechange";

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function getSnapshot(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** The server cannot know the stored preference; React re-renders with the
 *  real one right after hydration without reporting a mismatch. */
const getServerSnapshot = (): ThemePreference => "system";

function applyResolved(pref: ThemePreference) {
  const dark =
    pref === "dark" ||
    (pref === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

/**
 * Three states rather than a two-way flip: a plain toggle strands anyone whose
 * OS already switches at sunset, because once they touch it there is no way
 * back to "follow the system".
 *
 * Rendered as a radiogroup — the three options are one setting, and arrow-key
 * navigation between them is the behavior a screen-reader user expects.
 *
 * The preference lives in localStorage, which is an external store, so it is
 * read through useSyncExternalStore rather than mirrored into an effect. That
 * also keeps the control in sync across tabs for free.
 */
export function ThemeToggle({ onPhoto = false }: { onPhoto?: boolean }) {
  const pref = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // While on "system", the OS can flip underneath us — at sunset, or when the
  // user changes it in another window. Without this the page keeps the theme
  // it resolved at load.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyResolved("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function choose(next: ThemePreference) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing can refuse writes. The theme still applies for this
      // page view; it just won't survive a reload.
    }
    applyResolved(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  const border = onPhoto ? "var(--photo-rule)" : "var(--border-hairline)";
  const idleColor = onPhoto ? "var(--on-photo-dim)" : "var(--text-muted)";
  const activeColor = onPhoto ? "var(--on-photo)" : "var(--text-primary)";
  const activeBg = onPhoto ? "var(--photo-veil-strong)" : "var(--surface-2)";

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full border p-0.5"
      style={{
        borderColor: border,
        background: onPhoto ? "var(--photo-veil)" : "transparent",
        backdropFilter: onPhoto ? "blur(8px)" : undefined,
      }}
    >
      {OPTIONS.map(({ value, label, Icon }, i) => {
        const selected = pref === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={`${label} theme`}
            // Only the selected control stays in the tab order; arrow keys move
            // within the group, per the radiogroup pattern.
            tabIndex={selected ? 0 : -1}
            onClick={() => choose(value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next =
                OPTIONS[
                  (i + (e.key === "ArrowRight" ? 1 : 2)) % OPTIONS.length
                ];
              choose(next.value);
              // Focus follows selection so the arrow keys keep working.
              (
                e.currentTarget.parentElement?.children[
                  OPTIONS.indexOf(next)
                ] as HTMLElement | undefined
              )?.focus();
            }}
            className="flex h-7 w-7 items-center justify-center rounded-full transition-colors"
            style={{
              background: selected ? activeBg : "transparent",
              color: selected ? activeColor : idleColor,
            }}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
