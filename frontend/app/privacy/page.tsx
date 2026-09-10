import type { Metadata } from "next";
import Link from "next/link";
import { LegalPageLayout } from "@/components/LegalPageLayout";

export const metadata: Metadata = {
  title: "Privacy Policy — Streetwise NYC",
  description:
    "How Streetwise NYC collects, uses, and shares information when you search an NYC address.",
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPageLayout title="Privacy Policy" lastUpdated="September 10, 2026">
      <h2>Overview</h2>
      <p>
        Streetwise NYC (&ldquo;Streetwise,&rdquo; &ldquo;we,&rdquo;
        &ldquo;us&rdquo;) is a tool for looking up a Building Health Score and
        Block Quality Score for an NYC address, built from public NYC 311
        complaint data. There are no user accounts, no sign-up, and no
        payment on this site. This policy explains what little information
        the service does handle, and where it goes.
      </p>

      <h2>Information We Collect</h2>
      <p>
        <strong>Address search queries.</strong> When you type or select an
        address, that text is sent to our server so it can be resolved to a
        location and used to look up public 311 data for that area. It is
        not tied to an account, because there are no accounts.
      </p>
      <p>
        <strong>Locally stored data (your browser only).</strong> Two small
        pieces of state live in your browser&rsquo;s local storage and are
        never sent to our server:
      </p>
      <ul>
        <li>
          <strong>Theme preference</strong> (light/dark/system) — always on,
          used only to render the page in the color scheme you chose.
        </li>
        <li>
          <strong>Recent searches</strong> — up to five addresses you&rsquo;ve
          looked up, shown back to you as shortcuts. This is optional and
          off by default; see our{" "}
          <Link href="/cookies">Cookie Policy</Link> for how consent works.
        </li>
      </ul>
      <p>
        <strong>Information we do not collect.</strong> We do not ask for
        your name, email, phone number, or precise location beyond the
        address you choose to search. We do not use analytics or advertising
        trackers of any kind.
      </p>

      <h2>How Your Information Is Used</h2>
      <p>
        A searched address is used solely to return a report for that
        address: resolving it to a location, matching it against nearby 311
        complaints and amenities, and optionally generating a plain-language
        summary. It is not used for advertising, profiling, or sold to
        anyone.
      </p>

      <h2>Third Parties We Share Data With</h2>
      <p>
        <strong>Google Maps Platform.</strong> Address text you search is
        sent to Google&rsquo;s Geocoding and Places APIs (server-side) to
        resolve it to a location, and the Google Maps JavaScript SDK loads
        directly in your browser on the report and compare pages to render a
        map. Google&rsquo;s handling of that data is governed by{" "}
        <a
          href="https://policies.google.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Google&rsquo;s Privacy Policy
        </a>
        , which is outside our control.
      </p>
      <p>
        <strong>Google Gemini API.</strong> When a plain-language summary of
        a report is generated, only aggregated, already-public statistics
        (complaint counts by category, distances to amenities) are sent to
        Google&rsquo;s Gemini API — never the raw address text or any
        personal identifier.
      </p>
      <p>
        <strong>NYC Open Data (Socrata).</strong> The underlying 311
        complaint and amenity data comes from the City of New York&rsquo;s
        public open data portal. We only read this data; we don&rsquo;t send
        it anything about you.
      </p>
      <p>
        <strong>Hosting provider.</strong> Like virtually any web service,
        our hosting infrastructure may keep standard access logs (e.g., IP
        address, timestamp, requested URL) for a short period, for security
        and operational purposes.
      </p>

      <h2>Cookies and Local Storage</h2>
      <p>
        We don&rsquo;t use HTTP cookies. We use browser local storage for the
        theme preference and recent-searches items described above — see the{" "}
        <Link href="/cookies">Cookie Policy</Link> for details and how to
        change your choice.
      </p>

      <h2>Your Rights and Choices</h2>
      <p>
        Because there are no accounts and almost nothing is stored
        server-side tied to you, there is little to request deletion of
        beyond what&rsquo;s in your own browser — which you can already clear
        yourself (via your browser settings, or by declining/changing your
        choice in the cookie banner). If you believe we hold information
        about you and want to ask a question or make a request, contact us
        using the details below.
      </p>

      <h2>Children&rsquo;s Privacy</h2>
      <p>
        Streetwise is not directed at children under 13, and we do not
        knowingly collect information from children.
      </p>

      <h2>Data Retention</h2>
      <p>
        Cached results (complaint counts, amenity data, AI summaries) are
        stored server-side keyed only to a rounded map coordinate — never to
        a person or a raw address — and automatically expire on a rolling
        basis (typically within 24 hours, up to 30 days for slower-changing
        amenity data). Locally stored data stays on your device until you
        clear it or decline/revoke consent.
      </p>

      <h2>Changes to This Policy</h2>
      <p>
        If this policy changes, we&rsquo;ll update the &ldquo;Last
        updated&rdquo; date above. Continued use of the site after a change
        means you accept the updated policy.
      </p>

      <h2>Not Legal Advice</h2>
      <p>
        This policy is written in plain language to describe how the service
        actually works. It is not a substitute for professional legal
        advice, and shouldn&rsquo;t be treated as a guarantee of compliance
        with every law in every jurisdiction a visitor might be in.
      </p>

      <h2>Contact Us</h2>
      <p>
        Questions about this policy? Email{" "}
        <a href="mailto:pednekarvishal17@gmail.com">
          pednekarvishal17@gmail.com
        </a>
        .
      </p>
    </LegalPageLayout>
  );
}
