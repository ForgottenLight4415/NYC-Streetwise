"use client";

import { createPortal } from "react-dom";

/**
 * Renders children into `document.body` instead of wherever the component
 * tree happens to mount them.
 *
 * Every full-screen dialog in this app (`fixed inset-0`) needs this. The
 * report page's right rail (`ReportBody`'s `xl:sticky` column, holding
 * ActivitySpine/MapPanelLazy and whichever dialog is currently open) is
 * itself `position: sticky`, which creates its own stacking context
 * regardless of z-index. A dialog mounted underneath it is stuck comparing
 * its own z-index only against OTHER things inside that same rail — it can
 * never out-rank a sibling like ReportToolbar's sticky header (`z-30`), no
 * matter how high the dialog's own z-index goes, because the whole rail
 * (sitting at the implicit `z-index: auto` level one level up) loses that
 * comparison as a single unit. The visible symptom: the sticky toolbar
 * paints over the top of the dialog, and the backdrop never dims the main
 * column at all. Rendering into `document.body` sidesteps the trap instead
 * of chasing it with an ever-higher z-index.
 *
 * SSR-safe without an effect: every caller renders this only from state that
 * starts falsy (`openAmenity`, `selected`, ...), so it never mounts during
 * the server render or the initial client render `document` would be
 * missing for — by the time any of those go truthy, this is already running
 * client-side.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
