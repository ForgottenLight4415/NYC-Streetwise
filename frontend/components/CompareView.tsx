"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CompareColumn } from "./CompareColumn";

export function CompareView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const a = searchParams.get("a") ?? "";
  const b = searchParams.get("b") ?? "";

  function updateParam(key: "a" | "b", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`/compare?${params.toString()}`);
  }

  return (
    <div id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-[color:var(--text-primary)]">
        Compare two addresses
      </h1>
      <p className="mt-1 text-sm text-[color:var(--text-secondary)]">
        Side-by-side building and block scores to help you pick between options.
      </p>

      {/* Each column is a full report. Two of them only fit from lg up; below
          that they stack, which on a phone reads as A then B rather than as a
          comparison — the honest tradeoff, since a 160px-wide score panel
          would not be readable either. */}
      <div className="mt-6 grid gap-10 lg:grid-cols-2 lg:gap-8">
        <CompareColumn label="Address A" initialAddress={a} onAddressChange={(v) => updateParam("a", v)} />
        <CompareColumn label="Address B" initialAddress={b} onAddressChange={(v) => updateParam("b", v)} />
      </div>
    </div>
  );
}
