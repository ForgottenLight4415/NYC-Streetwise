import { Suspense } from "react";
import type { Metadata } from "next";
import { CompareView } from "@/components/CompareView";
import { mapsScriptSrc } from "@/lib/maps-keys";

function firstParam(v: string | string[] | undefined) {
  return (Array.isArray(v) ? v[0] : v)?.trim();
}

// Mirrors app/report/page.tsx's generateMetadata: per-comparison title, stays
// noindex for the same thin/duplicate-content reason. A single address isn't
// a comparison, so a partial a/b (one present, one missing) falls back to the
// same generic title as neither being present, rather than a half title like
// "123 Main St vs. ".
export async function generateMetadata({
  searchParams,
}: PageProps<"/compare">): Promise<Metadata> {
  const sp = await searchParams;
  const a = firstParam(sp.a);
  const b = firstParam(sp.b);

  if (!a || !b) {
    return {
      title: "Compare Addresses",
      robots: { index: false, follow: true },
      alternates: { canonical: "/compare" },
    };
  }

  const title = `${a} vs. ${b}`;
  const description = `Side-by-side Building Health and Block Quality Score comparison of ${a} and ${b}.`;

  return {
    title,
    description,
    robots: { index: false, follow: true },
    alternates: {
      canonical: `/compare?${new URLSearchParams({ a, b }).toString()}`,
    },
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default function ComparePage() {
  // See app/report/page.tsx - the SDK is loaded per-route, and this page can
  // mount two maps, so getting the bootstrap started with the document rather
  // than after hydration matters more here than anywhere.
  const scriptSrc = mapsScriptSrc();

  return (
    <>
      {scriptSrc && (
        <>
          <link rel="preconnect" href="https://maps.googleapis.com" />
          <script async src={scriptSrc} />
        </>
      )}
      <Suspense fallback={null}>
        <CompareView />
      </Suspense>
    </>
  );
}
