import type { Metadata } from "next";
import { LegalPageLayout } from "@/components/LegalPageLayout";

export const metadata: Metadata = {
  title: "Cookie Policy — Streetwise NYC",
  description:
    "What Streetwise NYC stores in your browser, and how to control it.",
};

export default function CookiePolicyPage() {
  return (
    <LegalPageLayout title="Cookie Policy" lastUpdated="September 10, 2026">
      <h2>Overview</h2>
      <p>
        Streetwise doesn&rsquo;t set any HTTP cookies. It uses your
        browser&rsquo;s local storage — data that stays on your device and is
        never sent to our server — for two small things, described below.
      </p>

      <h2>Strictly Necessary Storage — Theme Preference</h2>
      <p>
        We store your light/dark/system theme choice locally so the page can
        render in the right colors immediately, without a flash of the wrong
        theme while it loads. This contains no personal information and is
        always on — there&rsquo;s no consent banner for it because it&rsquo;s
        purely a rendering preference, comparable to your browser remembering
        window size.
      </p>

      <h2>Non-Essential Storage — Recent Searches</h2>
      <p>
        If you accept, we&rsquo;ll remember your last five searched addresses
        locally so you can quickly search them again. This is off by
        default. If you decline, or later change your mind, nothing is
        saved, and anything already saved is cleared immediately.
      </p>

      <h2>Third-Party Storage</h2>
      <p>
        On the report and compare pages, the Google Maps JavaScript SDK loads
        in your browser to render a map. Google may set its own cookies or
        local storage as part of that, governed by Google&rsquo;s own
        policies — outside our control and not covered by the choice you make
        in our cookie banner.
      </p>

      <h2>How to Change Your Choice</h2>
      <p>
        Click &ldquo;Cookie Preferences&rdquo; in the footer at any time to
        reopen the banner and change your choice.
      </p>

      <h2>Changes to This Policy</h2>
      <p>
        If this policy changes, we&rsquo;ll update the &ldquo;Last
        updated&rdquo; date above.
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
