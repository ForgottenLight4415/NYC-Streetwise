/**
 * The citywide 311 baseline every score is measured against.
 *
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Source: backend/src/config/baseline.json (the committed output of
 * `npm run baseline`). Regenerate with `npm run sync:baseline` from
 * frontend/, which `npm run baseline` also does for you; `npm run
 * verify:baseline` fails if this file has fallen behind.
 *
 * Committed rather than fetched deliberately: CitywideBaselinePanel is what the
 * homepage shows when the score cache is cold, so it cannot itself depend on
 * the backend being reachable, and compareToBaseline() is a synchronous pure
 * function called from client components. It is real measured data either way -
 * the point of showing it is that a page with nothing cached still has
 * something true to say.
 */

export interface BaselineBucket {
  /** Bucket key, matching CATEGORY_LABEL in lib/score.ts. */
  key: string;
  median: number;
  p90: number;
}

export interface BaselineTier {
  label: string;
  radiusMeters: number;
  colorVar: string;
  buckets: BaselineBucket[];
}

export const CITYWIDE_BASELINE: {
  windowMonths: number;
  sampleSize: number;
  version: string;
  tiers: BaselineTier[];
} = {
  windowMonths: 24,
  sampleSize: 250,
  version: "v1",
  tiers: [
    {
      label: "Building Health",
      radiusMeters: 25,
      colorVar: "--series-building",
      buckets: [
        { key: "heatHotWater", median: 32, p90: 169 },
        { key: "unsanitaryCondition", median: 10, p90: 48 },
        { key: "plumbing", median: 6, p90: 38 },
      ],
    },
    {
      label: "Block Quality",
      radiusMeters: 350,
      colorVar: "--series-block",
      buckets: [
        { key: "noise", median: 1005, p90: 3851 },
        { key: "parking", median: 1153, p90: 2661 },
        { key: "streetCondition", median: 106, p90: 217 },
      ],
    },
  ],
};
