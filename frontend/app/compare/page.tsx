import { Suspense } from "react";
import { CompareView } from "@/components/CompareView";
import { mapsScriptSrc } from "@/lib/maps-keys";

export default function ComparePage() {
  // See app/report/page.tsx — the SDK is loaded per-route, and this page can
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
