"use client";

import { useEffect, useRef } from "react";

/** Everything focusable inside a panel, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The three things a modal owes a keyboard or screen-reader user, in one place:
 * Escape closes it, Tab cannot leave it, and focus returns to whatever opened
 * it. Body scroll is locked too, so the page behind does not drift.
 *
 * Extracted rather than written twice — ComplaintDetailModal had only the
 * Escape handler, and adding a second dialog would have duplicated the gap.
 *
 * @returns a ref to put on the dialog PANEL (not the backdrop).
 */
export function useDialog(onClose: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Kept in a ref so changing the handler identity doesn't tear down the
  // listener and, with it, the stored focus target. Assigned in an effect
  // rather than during render, which would be a render-phase side effect.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Focus the panel itself rather than its first control: landing on "Close"
    // invites dismissing the dialog you just opened, and a screen reader reads
    // the panel's label from here.
    panel?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;

      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (items.length === 0) {
        // Nothing to land on — keep focus on the panel instead of letting Tab
        // escape to the page behind.
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends. Focus sitting on the panel itself counts as "before
      // the first item", so a forward Tab from there enters the list.
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Guarded: the opener can be gone if the dialog outlived it, and calling
      // focus() on a detached node silently moves focus to <body>.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return panelRef;
}
