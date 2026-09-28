import { Suspense } from "react";
import type { Metadata } from "next";
import { ReportLoading } from "@/components/ReportLoading";
import { ReportView } from "@/components/ReportView";
import { mapsScriptSrc } from "@/lib/maps-keys";

function firstParam(v: string | string[] | undefined) {
  return (Array.isArray(v) ? v[0] : v)?.trim();
}

// Every address gets its own title/description/canonical so a shared link
// (or a browser tab) shows the searched address, not a generic one-size-fits
// -all string. Stays noindex: the report content itself is 100% client
// -fetched after JS (see ReportView.tsx), so indexing the thousands of
// possible ?address= variants would just be thin/duplicate content - see
// frontend/CLAUDE.md on why that fetch is deliberately client-side.
export async function generateMetadata({
  searchParams,
}: PageProps<"/report">): Promise<Metadata> {
  const sp = await searchParams;
  const address = firstParam(sp.address);

  if (!address) {
    return {
      title: "Address Report",
      robots: { index: false, follow: true },
      alternates: { canonical: "/report" },
    };
  }

  const description = `Building Health Score and Block Quality Score for ${address}, built from public NYC 311 complaint data.`;

  return {
    title: address,
    description,
    robots: { index: false, follow: true },
    alternates: {
      canonical: `/report?${new URLSearchParams({ address }).toString()}`,
    },
    openGraph: { title: address, description },
    twitter: { title: address, description },
  };
}

export default function ReportPage() {
  // The Maps SDK is requested here rather than from the root layout, because
  // this and /compare are the only routes that ever build a map - the homepage
  // was paying for a third-party bootstrap and its follow-on request chain to
  // render a page with no map on it.
  //
  // It has to be a server component that does this: the client key is
  // deliberately NOT NEXT_PUBLIC_ (see lib/maps-keys.ts), so a client component
  // cannot read it. React 19 hoists `<script async src>` into <head> for us.
  const scriptSrc = mapsScriptSrc();

  return (
    <>
      {scriptSrc && (
        <>
          <link rel="preconnect" href="https://maps.googleapis.com" />
          <script async src={scriptSrc} />
        </>
      )}
      <Suspense fallback={<ReportLoading />}>
        <ReportView />
      </Suspense>
    </>
  );
}
