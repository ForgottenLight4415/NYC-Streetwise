import { formatDistance } from "@/lib/amenities";
import { CITYWIDE_BASELINE } from "@/lib/citywide-baseline";
import { CATEGORY_LABEL } from "@/lib/score";

/**
 * What the homepage shows where the address carousel goes when nothing is
 * cached yet.
 *
 * It is not a placeholder. Every number here is real measured data — the
 * citywide baseline each score is computed against — so a cold cache costs the
 * page its examples, not its honesty. It also answers the question the carousel
 * only implies: a score of 62 means nothing until you know what the median block
 * looks like.
 *
 * Server component, static data, no fetch.
 */
export function CitywideBaselinePanel() {
  const { tiers, windowMonths, sampleSize } = CITYWIDE_BASELINE;

  return (
    <div
      className="rounded-lg bg-(--surface-1) p-6 sm:p-8"
      style={{ border: "1px solid var(--border-hairline)" }}
    >
      <div className="grid gap-8 sm:grid-cols-2 sm:gap-10">
        {tiers.map((tier) => (
          <div key={tier.label}>
            <div className="flex items-baseline justify-between gap-3">
              <h3
                className="text-sm font-semibold"
                style={{ color: `var(${tier.colorVar}-ink)` }}
              >
                {tier.label}
              </h3>
              <span className="font-data text-xs text-(--text-muted)">
                {formatDistance(tier.radiusMeters)} radius
              </span>
            </div>

            {/* A table, not a chart: two numbers per row is a reading task, and
                bars here would compete with the real scores above the fold. */}
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className="text-(--text-muted)">
                  <th className="py-1.5 text-left font-normal text-xs">
                    Complaint type
                  </th>
                  <th className="py-1.5 text-right font-normal text-xs">
                    Median
                  </th>
                  <th className="py-1.5 text-right font-normal text-xs">
                    90th pct
                  </th>
                </tr>
              </thead>
              <tbody>
                {tier.buckets.map((bucket) => (
                  <tr
                    key={bucket.key}
                    className="border-t"
                    style={{ borderColor: "var(--border-hairline)" }}
                  >
                    <td className="py-2 pr-3 text-(--text-secondary)">
                      {CATEGORY_LABEL[bucket.key] ?? bucket.key}
                    </td>
                    <td className="font-data py-2 text-right tabular-nums text-(--text-primary)">
                      {bucket.median.toLocaleString()}
                    </td>
                    <td className="font-data py-2 text-right tabular-nums text-(--text-muted)">
                      {bucket.p90.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <p className="mt-6 text-xs leading-relaxed text-(--text-muted)">
        Complaints per location over a trailing {windowMonths} months, measured
        across {sampleSize} coordinates sampled from all five boroughs. Every
        score on this site is a position against these figures — which is why a
        block with 900 noise complaints still scores as average.
      </p>
    </div>
  );
}
