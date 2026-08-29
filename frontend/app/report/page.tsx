import { Suspense } from "react";
import { ReportLoading } from "@/components/ReportLoading";
import { ReportView } from "@/components/ReportView";
import { mapsScriptSrc } from "@/lib/maps-keys";

export default function ReportPage() {
  // The Maps SDK is requested here rather than from the root layout, because
  // this and /compare are the only routes that ever build a map — the homepage
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
