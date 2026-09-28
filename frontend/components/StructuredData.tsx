import { SITE_URL } from "@/lib/site-url";

// No SearchAction/potentialAction here: it powered Google's sitelinks search
// box, which Google retired sitewide on 2024-11-21 - the markup would be
// harmless but no longer does anything.
const STRUCTURED_DATA = [
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Streetwise NYC",
    url: SITE_URL,
    description:
      "Search any NYC address for a Building Health Score and Block Quality Score built from public 311 complaint data.",
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Streetwise NYC",
    url: SITE_URL,
    logo: `${SITE_URL}/logo-icon.png`,
  },
];

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
    />
  );
}
