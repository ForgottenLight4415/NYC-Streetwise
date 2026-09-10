"use client";

import Image from "next/image";
import Link from "next/link";
import { reopenConsentBanner } from "@/lib/consent";

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/cookies", label: "Cookie Policy" },
];

export function Footer() {
  return (
    <footer
      className="mt-4 border-t"
      style={{ borderColor: "var(--border-hairline)" }}
    >
      <div className="mx-auto max-w-6xl px-4 py-12 text-center sm:px-6">
        <Image
          src="/logo-full.png"
          alt="Streetwise — Rent smart in NYC"
          width={907}
          height={301}
          className="mx-auto mb-6 h-auto w-55 sm:w-65"
        />
        <p className="mx-auto max-w-2xl text-xs leading-relaxed text-(--text-muted)">
          Data source: NYC 311 Service Requests (Socrata, dataset erm2-nwe9).
        </p>
        <p className="mt-1.5 text-xs text-(--text-muted)">
          Hero photo by{" "}
          <a
            href="https://unsplash.com/photos/manhattan-skyline-at-night-ZXBPMnNVtlE"
            className="underline underline-offset-2 hover:text-(--text-secondary)"
          >
            Jan Folwarczny
          </a>{" "}
          on Unsplash.
        </p>

        <nav
          aria-label="Legal"
          className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-(--text-muted)"
        >
          {LEGAL_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="underline underline-offset-2 hover:text-(--text-secondary)"
            >
              {label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => reopenConsentBanner()}
            className="underline underline-offset-2 hover:text-(--text-secondary)"
          >
            Cookie Preferences
          </button>
        </nav>

        <p className="mt-4 text-xs text-(--text-muted)">
          © 2026 Vishal Rajendra Pednekar. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
