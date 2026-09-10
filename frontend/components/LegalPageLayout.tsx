import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared shell for /privacy, /terms, /cookies. No typography plugin is
 * installed, so heading/paragraph rhythm is applied here via descendant
 * selectors rather than a `prose` class — every element inside `children`
 * should still be a real semantic tag (h2, p, ul, a), never a styled div.
 */
export function LegalPageLayout({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Link
        href="/"
        className="text-sm text-(--text-muted) underline underline-offset-2 hover:text-(--text-secondary)"
      >
        ← Back to home
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-(--text-primary) sm:text-3xl">
        {title}
      </h1>
      <p className="mt-1 text-sm text-(--text-muted)">
        Last updated: {lastUpdated}
      </p>
      <article
        className="mt-8 [&_a]:text-(--brand-ink) [&_a]:underline [&_a]:underline-offset-2
          [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-(--text-primary) [&_h2:first-child]:mt-0
          [&_li]:mt-1 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mt-3 [&_p]:leading-relaxed [&_p]:text-(--text-secondary)
          [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5"
      >
        {children}
      </article>
    </main>
  );
}
