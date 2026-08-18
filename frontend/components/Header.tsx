"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ScaleIcon, SearchIcon } from "./icons";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const pathname = usePathname();
  // The home hero is a full-bleed photograph and the header sits on top of it,
  // so on that page only, the bar starts transparent and picks up its surface
  // once the photo has scrolled past.
  const overHero = pathname === "/";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!overHero) return;
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [overHero]);

  const onPhoto = overHero && !scrolled;

  return (
    <header
      className="sticky top-0 z-40 transition-colors duration-300"
      style={
        onPhoto
          ? { background: "transparent" }
          : {
              background:
                "color-mix(in srgb, var(--surface-1) 88%, transparent)",
              backdropFilter: "blur(12px)",
              borderBottom: "1px solid var(--border-hairline)",
            }
      }
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight"
          style={{ color: onPhoto ? "var(--on-photo)" : "var(--text-primary)" }}
        >
          {/* The asset is 226x281, not square, so the old 34x34 was squashing
              it. Intrinsic size now matches that ratio, and both dimensions are
              given in CSS (h-9 + w-auto) — Tailwind's preflight sets
              `height: auto` on images, and setting only one of the two is what
              Next warns about. */}
          <Image
            src="/logo-icon.png"
            alt=""
            width={226}
            height={281}
            className="h-9 w-auto rounded-lg"
            priority
          />
          <span className="font-display">Streetwise</span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/compare"
            aria-current={pathname === "/compare" ? "page" : undefined}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-2 text-sm font-medium transition-colors sm:px-3"
            style={{
              color: onPhoto ? "var(--on-photo-dim)" : "var(--text-secondary)",
            }}
          >
            <ScaleIcon className="h-4 w-4 sm:hidden" />
            <span className="hidden sm:inline">Compare</span>
            {/* Reachable label for the icon-only phone rendering. */}
            <span className="sr-only sm:hidden">Compare addresses</span>
          </Link>

          <ThemeToggle onPhoto={onPhoto} />

          {/* On the home page the search field is already the centrepiece, so
              this only appears once it has scrolled out of reach. */}
          {!onPhoto && (
            <Link
              href="/"
              className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold transition-colors sm:px-4"
              style={{ background: "var(--brand)", color: "#ffffff" }}
            >
              <SearchIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Search an address</span>
              {/* Icon-only on a phone, like Compare above it: with both labels
                  spelled out the row overflowed a 360px viewport by 14px. */}
              <span className="sr-only sm:hidden">Search an address</span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
