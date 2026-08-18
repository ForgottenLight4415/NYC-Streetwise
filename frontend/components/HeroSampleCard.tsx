"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchReport } from "@/lib/api";
import { RENTING_FACTS } from "@/lib/renting-facts";
import { BAND_VAR, BAND_VERDICT, overallBand } from "@/lib/score";
import type { ReportResponse, ShowcaseFallback, ShowcaseItem } from "@/lib/types";
import { FactRotator } from "./FactRotator";
import { ArrowRightIcon } from "./icons";

/** One score in the data face — the readout this product exists to produce. */
function ScoreReadout({
  label,
  score,
  radius,
  inkVar,
}: {
  label: string;
  score: number;
  radius: string;
  inkVar: string;
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span
        className="font-data text-3xl font-semibold leading-none"
        style={{ color: `var(${inkVar})` }}
      >
        {score}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-(--text-primary)">
          {label}
        </span>
        <span className="font-data block text-[11px] text-(--text-muted)">
          {radius}
        </span>
      </span>
    </div>
  );
}

/**
 * The card straddling the hero's bottom edge: one real report, so the output is
 * the argument.
 *
 * It used to render a deterministic fake — a seeded PRNG dressed up as "456 Park
 * Ave". Now there are exactly two ways it can show a number, and neither invents
 * one:
 *
 *  1. `item` — an address the backend already had cached, picked at random and
 *     server-rendered. No client fetch, no flash, the common case once the cache
 *     is warm.
 *  2. Nothing cached — it fetches a real score on mount for the address the
 *     backend nominated. That is a live Socrata call (0.3-2.5s, tail 8.3s),
 *     which is exactly why it happens HERE and not on the server: the rest of
 *     the page renders and is fully usable while this one card fills itself in.
 *
 * The fallback subject comes from the backend, drawn at random from its curated
 * pre-warmed list, so a cold homepage is not permanently fronted by one
 * building and this component holds no address of its own.
 *
 * If the fetch fails, or there is no subject to fetch, the card renders nothing
 * at all. A homepage missing a card is fine; a homepage showing a made-up score
 * is the bug this replaced.
 */
export function HeroSampleCard({
  item,
  fallback,
}: {
  item: ShowcaseItem | null;
  fallback: ShowcaseFallback | null;
}) {
  // Only the *fetched* report is state. When `item` is present nothing here runs.
  const [fetched, setFetched] = useState<ReportResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (item || !fallback) return;
    let cancelled = false;
    fetchReport(fallback.lat, fallback.lng)
      .then((data) => {
        if (!cancelled) setFetched(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [item, fallback]);

  const data: ReportResponse | ShowcaseItem | null = item ?? fetched;
  const address = item?.address ?? fallback?.address;
  const borough = item?.borough ?? fallback?.borough ?? null;

  // No cached item and no subject to score means the backend is unreachable —
  // the same call that would fetch the score just failed. Show nothing.
  if (failed || !address) return null;

  return (
    <div className="mx-auto -mb-16 max-w-6xl px-4 sm:px-6 lg:-mb-20">
      {data ? (
        <Card address={address} borough={borough} data={data} />
      ) : (
        <Placeholder />
      )}
    </div>
  );
}

function Card({
  address,
  borough,
  data,
}: {
  address: string;
  borough: string | null;
  data: ReportResponse;
}) {
  const band = overallBand(data.buildingHealth.band, data.blockQuality.band);

  return (
    <Link
      href={`/report?address=${encodeURIComponent(address)}`}
      className="card-pop group flex flex-col gap-5 rounded-xl p-5 sm:flex-row sm:items-center sm:gap-8 sm:p-6 lg:max-w-3xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border-hairline)",
      }}
    >
      <div className="min-w-0 flex-1">
        <p className="font-data text-[11px] uppercase tracking-[0.16em] text-(--text-muted)">
          {/* Not "Sample report" any more — there is no sample, this is the
              address's actual 311 record. */}
          Live report{borough ? ` · ${borough}` : ""}
        </p>
        <p className="font-display mt-1.5 truncate text-xl font-semibold text-(--text-primary)">
          {address.split(",")[0]}
        </p>
        <p
          className="mt-0.5 text-sm font-medium"
          style={{ color: `var(${BAND_VAR[band]}-ink)` }}
        >
          {BAND_VERDICT[band]}
        </p>
      </div>

      <div className="flex shrink-0 gap-6 sm:gap-8">
        <ScoreReadout
          label="Building"
          score={data.buildingHealth.score}
          radius={`${data.buildingHealth.radiusMeters}m`}
          inkVar="--series-building-ink"
        />
        <ScoreReadout
          label="Block"
          score={data.blockQuality.score}
          radius={`${data.blockQuality.radiusMeters}m`}
          inkVar="--series-block-ink"
        />
      </div>

      <span
        className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full sm:flex"
        style={{ background: "var(--brand-tint)", color: "var(--brand-ink)" }}
        aria-hidden
      >
        <ArrowRightIcon className="h-4.5 w-4.5" />
      </span>
      <span className="text-sm font-semibold text-(--brand-ink) sm:hidden">
        See the full report →
      </span>
    </Link>
  );
}

/**
 * Holds the card's ground while the real score is fetched.
 *
 * No spinner: the page around this is finished and usable, and a spinner would
 * claim otherwise. Renting facts rather than the NYC trivia the report waits
 * use — a visitor who has not searched anything yet is being given a reason to,
 * not entertained through a wait they chose.
 *
 * Sized to roughly the card it replaces so the section below does not jump when
 * the real one arrives.
 */
function Placeholder() {
  return (
    <div
      className="rounded-xl lg:max-w-3xl"
      style={{
        background: "var(--surface-1)",
        border: "1px solid var(--border-hairline)",
      }}
    >
      <FactRotator
        showSpinner={false}
        facts={RENTING_FACTS}
        className="gap-2.5 px-5 py-6 sm:px-6"
        title="Pulling a live report"
        subtitle="Reading one address’s 311 record straight from the city."
      />
    </div>
  );
}
