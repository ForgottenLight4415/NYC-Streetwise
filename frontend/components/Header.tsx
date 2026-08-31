"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AddressSearch } from "./AddressSearch";
import { ScaleIcon } from "./icons";
import { ThemeToggle } from "./ThemeToggle";

// Reads the current address off the URL, so the header's field opens
// pre-filled with what the report is actually showing. Split out from Header
// itself so the useSearchParams-driven client bailout during prerendering is
// scoped to just this field rather than the whole bar — see the Suspense
// boundary around it below.
function HeaderAddressSearch() {
  const searchParams = useSearchParams();
  const address = searchParams.get("address") ?? "";
  return <AddressSearch key={address} size="sm" initialValue={address} />;
}

export function Header() {
  const pathname = usePathname();
  // The home hero is a full-bleed photograph and the header sits on top of it,
  // so on that page only, the bar starts transparent and picks up its surface
  // once the photo has scrolled past.
  const overHero = pathname === "/";
  // The home page already has the search field as its centerpiece, and every
  // other page (aside from the report, which gets its own field below) has no
  // use for one in the bar.
  const onReportPage = pathname === "/report";
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
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 text-xl font-semibold tracking-tight"
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
            width={280}
            height={280}
            className="h-9 w-auto rounded-lg"
            priority
          />
          <span className="font-display">Streetwise</span>
        </Link>

        {onReportPage && (
          <div className="min-w-0 ml-auto flex-1 sm:max-w-md">
            <Suspense fallback={<div className="h-11" />}>
              <HeaderAddressSearch />
            </Suspense>
          </div>
        )}

        <div className="ml-1 flex shrink-0 items-center gap-2 sm:gap-3">
          <Link
            href="/compare"
            aria-current={pathname === "/compare" ? "page" : undefined}
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-full px-5 text-md font-semibold transition-colors"
            style={{ background: "var(--brand)", color: "#ffffff" }}
          >
            <ScaleIcon className="h-4 w-4 sm:hidden" />
            <span className="hidden sm:inline">Compare</span>
            {/* Reachable label for the icon-only phone rendering. */}
            <span className="sr-only sm:hidden">Compare addresses</span>
          </Link>
        </div>

        <div className="ml-auto">
          <ThemeToggle onPhoto={onPhoto} />
        </div>
      </div>
    </header>
  );
}
