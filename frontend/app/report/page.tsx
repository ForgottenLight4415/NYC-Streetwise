import { Suspense } from "react";
import { ReportLoading } from "@/components/ReportLoading";
import { ReportView } from "@/components/ReportView";

export default function ReportPage() {
  return (
    <Suspense fallback={<ReportLoading />}>
      <ReportView />
    </Suspense>
  );
}
