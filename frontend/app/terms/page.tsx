import type { Metadata } from "next";
import { LegalPageLayout } from "@/components/LegalPageLayout";

export const metadata: Metadata = {
  title: "Terms & Conditions — Streetwise NYC",
  description: "The terms that govern your use of Streetwise NYC.",
};

export default function TermsPage() {
  return (
    <LegalPageLayout
      title="Terms & Conditions"
      lastUpdated="September 10, 2026"
    >
      <h2>Acceptance of Terms</h2>
      <p>
        By using Streetwise NYC (&ldquo;the Service&rdquo;), you agree to
        these Terms &amp; Conditions. If you don&rsquo;t agree, please
        don&rsquo;t use the Service.
      </p>

      <h2>Description of Service</h2>
      <p>
        Streetwise NYC lets you search an NYC address and view a Building
        Health Score and Block Quality Score, along with related amenity
        information, computed from public NYC 311 Service Request data and
        other public data sources.
      </p>

      <h2>Informational Purposes Only — Not for Housing, Lending, Insurance, or Employment Decisions</h2>
      <p>
        The scores and information on this site are derived from complaint
        volume and public data, are provided for general informational and
        educational purposes only, and are <strong>not</strong> a
        professional inspection, appraisal, background check, or risk
        assessment of any kind. Complaint data can reflect many factors
        unrelated to a building&rsquo;s actual condition, and using
        complaint-density figures to make decisions about people or
        properties can produce unfair or discriminatory outcomes.
      </p>
      <p>
        You agree not to use Streetwise, or any score or data from it, as a
        factor in a decision to rent, sell, insure, lend against, or offer
        employment related to any property or person — including decisions
        that could implicate the federal Fair Housing Act or New York State
        or New York City human rights laws. Any such decision should rely on
        a licensed professional&rsquo;s in-person inspection and appropriate
        legal or compliance review, not on this Service.
      </p>

      <h2>Data Accuracy Disclaimer</h2>
      <p>
        NYC 311 data may be incomplete, delayed, or contain errors introduced
        by the City&rsquo;s own systems, and we make no guarantee that a
        score reflects the current or complete condition of any address or
        block. Where a report includes an AI-generated plain-language
        summary, that summary may occasionally misstate or oversimplify the
        underlying numbers — the numeric data on the page is always the
        source of truth, not the summary text.
      </p>

      <h2>No Warranty; Limitation of Liability</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as
        available,&rdquo; without warranties of any kind, express or
        implied, including accuracy, completeness, or fitness for a
        particular purpose. To the fullest extent permitted by law, we are
        not liable for any damages arising from your use of, or reliance on,
        the Service.
      </p>

      <h2>Acceptable Use</h2>
      <p>
        Don&rsquo;t attempt to scrape, overload, or abuse the Service beyond
        ordinary browsing use, circumvent rate limits, or use it to violate
        any applicable law.
      </p>

      <h2>Intellectual Property</h2>
      <p>
        The Streetwise name, logo, and site design are owned by us. Data
        sourced from NYC Open Data remains subject to the City&rsquo;s own
        public-data terms; we make no ownership claim over that underlying
        data.
      </p>

      <h2>Third-Party Services and Links</h2>
      <p>
        The Service uses Google Maps Platform and Google&rsquo;s Gemini API,
        each governed by Google&rsquo;s own terms, and links to third-party
        sites (such as Unsplash and NYC Open Data) that we don&rsquo;t
        control and aren&rsquo;t responsible for.
      </p>

      <h2>Governing Law</h2>
      <p>
        These Terms are governed by the laws of the State of New York,
        without regard to conflict-of-law principles.
      </p>

      <h2>Children&rsquo;s Use of the Service</h2>
      <p>
        The Service is not directed at, and should not be used by, children
        under 13.
      </p>

      <h2>Changes to These Terms</h2>
      <p>
        We may update these Terms from time to time; the &ldquo;Last
        updated&rdquo; date above will reflect the latest revision.
        Continued use of the Service after a change means you accept the
        updated Terms.
      </p>

      <h2>Contact Us</h2>
      <p>
        Questions about these Terms? Email{" "}
        <a href="mailto:pednekarvishal17@gmail.com">
          pednekarvishal17@gmail.com
        </a>
        .
      </p>
    </LegalPageLayout>
  );
}
