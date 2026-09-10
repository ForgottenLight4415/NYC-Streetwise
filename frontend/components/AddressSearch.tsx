"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import { useSuggestions } from "@/lib/hooks";
import { SearchIcon, ClockIcon, MapPinIcon } from "./icons";
import type { AutocompleteSuggestion } from "@/lib/types";
import {
  saveRecentSearch,
  subscribeRecents,
  getRecentsSnapshot,
  getRecentsServerSnapshot,
} from "@/lib/recentSearches";
import { getConsent } from "@/lib/consent";

/* One document-level pointerdown listener for every AddressSearch on the page,
   rather than one each. The compare view mounts three of these (two columns
   plus the header), and each was independently binding to `document`. */

const outsideSubscribers = new Set<(e: PointerEvent) => void>();

function onDocumentPointerDown(e: PointerEvent) {
  // Copied first: a subscriber closing its panel can unsubscribe during the
  // loop, and mutating a Set mid-iteration skips the neighbour.
  for (const notify of Array.from(outsideSubscribers)) notify(e);
}

function subscribeOutside(notify: (e: PointerEvent) => void) {
  if (outsideSubscribers.size === 0) {
    // pointerdown rather than mousedown so a tap outside on a touchscreen
    // closes the panel too.
    document.addEventListener("pointerdown", onDocumentPointerDown);
  }
  outsideSubscribers.add(notify);
  return () => {
    outsideSubscribers.delete(notify);
    if (outsideSubscribers.size === 0) {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
    }
  };
}

const NO_SUGGESTIONS: AutocompleteSuggestion[] = [];

export function AddressSearch({
  size = "hero",
  autoFocus = false,
  placeholder,
  initialValue = "",
  onSelect,
}: {
  /** `hero` is the photographic home-page treatment; `sm` is the inline field. */
  size?: "hero" | "sm";
  autoFocus?: boolean;
  placeholder?: string;
  initialValue?: string;
  onSelect?: (address: string, placeId?: string) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialValue);
  // The debounce is a separate piece of state from the query so the SWR key
  // only moves once typing settles. Every distinct key is a billed Places
  // call, which is what the delay is protecting — not render cost.
  const [debounced, setDebounced] = useState(initialValue.trim());
  const recents = useSyncExternalStore(
    subscribeRecents,
    getRecentsSnapshot,
    getRecentsServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const trimmed = query.trim();

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timeout);
  }, [query]);

  const fetchedSuggestions = useSuggestions(debounced);
  // Still gated on the key matching what is actually in the box. SWR clears
  // `data` when the key moves, but during the 150ms before it moves the hook
  // is still holding the PREVIOUS query's results — which is exactly the
  // "clear the field, type again, see the old list" case.
  const suggestions = debounced === trimmed ? fetchedSuggestions : NO_SUGGESTIONS;

  useEffect(
    () =>
      subscribeOutside((e) => {
        if (
          containerRef.current &&
          !containerRef.current.contains(e.target as Node)
        ) {
          setOpen(false);
        }
      }),
    [],
  );

  const showingRecents = !trimmed && recents.length > 0;
  const options: { key: string; label: string; placeId?: string }[] = trimmed
    ? suggestions.map((s) => ({
        key: s.id,
        label: s.description,
        placeId: s.id || undefined,
      }))
    : recents.map((a) => ({ key: a, label: a }));

  function go(address: string, placeId?: string) {
    const trimmed = address.trim();
    if (!trimmed) return;
    // Notifies the external-store subscription, which re-reads localStorage.
    // Off by default: nothing is written until the cookie-consent banner has
    // been explicitly accepted (see lib/consent.ts).
    if (getConsent() === "accepted") saveRecentSearch(trimmed);
    setOpen(false);
    setQuery(trimmed);
    if (onSelect) {
      onSelect(trimmed, placeId);
    } else {
      const params = new URLSearchParams({ address: trimmed });
      if (placeId) params.set("placeId", placeId);
      router.push(`/report?${params.toString()}`);
    }
  }

  /**
   * What the search button does, and what Enter falls back to.
   *
   * Prefers a real suggestion over the typed text, for the same reason Enter
   * does: picking one yields a placeId, which is what makes the resolved address
   * Google's own canonical string rather than something a person typed. Raw text
   * still works — it has to, or the box would be unusable whenever Places is
   * unreachable and the seed fallback is empty — it just resolves through plain
   * geocoding and is deliberately never recorded on the homepage.
   */
  function submit() {
    const active = activeIdx >= 0 ? options[activeIdx] : options[0];
    if (trimmed && active) return go(active.label, active.placeId);
    go(query);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveIdx(-1);
      return;
    }
    if (!open || options.length === 0) {
      if (e.key === "Enter") submit();
      if (e.key === "ArrowDown") setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Falls back to the FIRST suggestion, not to the raw text, when nothing is
      // highlighted. Someone who types "456 park" and hits Enter means the
      // building at the top of the list; sending the fragment instead makes
      // Google guess, and only a picked suggestion carries the placeId that lets
      // the homepage record a canonical address (see app/api/geocode/route.ts).
      const active = activeIdx >= 0 ? options[activeIdx] : options[0];
      go(active?.label ?? query, active?.placeId);
    }
  }

  const hero = size === "hero";
  const showPanel = open && (trimmed.length > 0 || recents.length > 0);

  return (
    <div
      ref={containerRef}
      className={`relative w-full ${hero ? "on-photo" : ""}`}
    >
      <div className="relative">
        <SearchIcon
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-(--text-muted) ${
            hero ? "left-5 h-5 w-5" : "left-4 h-4 w-4"
          }`}
        />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIdx(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Enter an NYC address"}
          aria-label="Search an NYC address"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            showPanel && activeIdx >= 0
              ? `${listboxId}-opt-${activeIdx}`
              : undefined
          }
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          className={`search-field w-full rounded-full border bg-(--surface-1) text-(--text-primary) placeholder:text-(--text-muted) ${
            hero
              ? "search-field--hero h-14 pl-12 pr-15 text-[15px] sm:h-16 sm:pl-14 sm:pr-18 sm:text-base"
              : "h-11 pl-10 pr-12 text-sm"
          }`}
          style={{ borderColor: "var(--border-strong)" }}
        />

        {/* The reference's circular submit. It is a real button, not decoration:
            on a phone keyboard the return key is the primary path, but a
            visible target matters when the field is pre-filled. */}
        <button
          type="button"
          onClick={() => submit()}
          aria-label="Search"
          className={`absolute top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full transition-colors ${
            hero ? "right-2 h-11 w-11 sm:h-12 sm:w-12" : "right-1.5 h-8 w-8"
          }`}
          style={{ background: "var(--brand)", color: "#ffffff" }}
        >
          <SearchIcon className={hero ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} />
        </button>
      </div>

      {showPanel && (
        <div
          // z-50 puts the panel above the sticky header (z-40). At z-30 the
          // header intercepted taps on any suggestion that scrolled beneath it,
          // which on a phone is the top one or two.
          className="absolute z-50 mt-2 w-full overflow-hidden rounded-lg border"
          style={{
            borderColor: "var(--border-hairline)",
            background: "var(--surface-1)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {showingRecents && (
            <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-(--text-muted)">
              Recent
            </p>
          )}
          {options.length > 0 ? (
            <ul
              id={listboxId}
              role="listbox"
              aria-label={
                showingRecents ? "Recent searches" : "Address suggestions"
              }
              // Capped so a long list can't run off a short phone viewport.
              className="max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain"
            >
              {options.map((opt, i) => {
                const Icon = showingRecents ? ClockIcon : MapPinIcon;
                return (
                  <li
                    key={opt.key}
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={i === activeIdx}
                    // pointerdown, not click: mousedown would already have blurred
                    // the input and closed the panel on some mobile browsers.
                    onPointerDown={(e) => {
                      e.preventDefault();
                      go(opt.label, opt.placeId);
                    }}
                    onMouseEnter={() => setActiveIdx(i)}
                    // 44px minimum target — this is the primary control on a phone.
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left text-sm transition-colors"
                    style={{
                      background:
                        i === activeIdx ? "var(--surface-2)" : "transparent",
                      color: "var(--text-primary)",
                    }}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-(--text-muted)" />
                    <span className="min-w-0 flex-1">{opt.label}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                go(query);
              }}
              className="flex min-h-11 w-full items-center gap-2.5 px-4 py-3 text-left text-sm text-(--text-primary)"
            >
              <SearchIcon className="h-4 w-4 shrink-0 text-(--text-muted)" />
              Search &ldquo;{query}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
