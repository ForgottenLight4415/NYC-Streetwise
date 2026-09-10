"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  getConsentSnapshot,
  getConsentServerSnapshot,
  setConsent,
  subscribeConsent,
  subscribeReopen,
} from "@/lib/consent";

/**
 * A banner, not a modal: it does not block the rest of the page (no focus
 * trap, no Escape-to-close, no backdrop) so a visitor can keep using the
 * site while deciding. It offers Accept/Decline only - deliberately no bare
 * "X" dismiss, so closing it can never be mistaken for a choice either way.
 *
 * Visible when there is no stored choice yet, OR when the footer's "Cookie
 * Preferences" control fires the reopen event to let someone change an
 * existing choice. Those are tracked separately (see lib/consent.ts) so
 * reopening never gets confused with "undecided".
 */
export function CookieConsent() {
  const consent = useSyncExternalStore(
    subscribeConsent,
    getConsentSnapshot,
    getConsentServerSnapshot,
  );
  const [forcedOpen, setForcedOpen] = useState(false);

  useEffect(() => subscribeReopen(() => setForcedOpen(true)), []);

  const visible = consent === null || forcedOpen;
  if (!visible) return null;

  function choose(choice: "accepted" | "declined") {
    setConsent(choice);
    setForcedOpen(false);
  }

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t"
      style={{
        borderColor: "var(--border-hairline)",
        background: "var(--surface-1)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="max-w-2xl text-sm leading-relaxed text-(--text-secondary)">
          We keep your theme preference on this device to avoid a flash of the
          wrong colors - that&rsquo;s always on and never leaves your browser.
          Remembering your recent searches is optional and stays off until you
          accept.{" "}
          <Link
            href="/cookies"
            className="underline underline-offset-2 text-(--brand-ink)"
          >
            Cookie Policy
          </Link>
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => choose("declined")}
            className="rounded-full border px-4 py-2 text-sm font-semibold text-(--text-primary) transition-colors hover:bg-(--surface-2)"
            style={{ borderColor: "var(--border-strong)" }}
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => choose("accepted")}
            // brand-tint + brand-ink, not brand + white: the brand fill is
            // tuned as a *text* color in the dark theme (7.3:1 against a dark
            // surface), so white text on top of it fails AA there. The
            // tint/ink pair is the token system's existing answer for a
            // filled brand surface that stays accessible in both themes.
            className="rounded-full px-4 py-2 text-sm font-semibold transition-colors"
            style={{
              background: "var(--brand-tint)",
              color: "var(--brand-ink)",
            }}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
