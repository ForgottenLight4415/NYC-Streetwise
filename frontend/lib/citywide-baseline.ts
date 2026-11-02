/**
 * The citywide 311 baseline every score is measured against.
 *
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Source: backend/src/config/baseline.json (the committed output of
 * `yarn baseline`). Regenerate with `yarn sync:baseline` from
 * frontend/, which `yarn baseline` also does for you; `yarn
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
        { key: "heatHotWater", median: 34, p90: 167 },
        { key: "unsanitaryCondition", median: 11, p90: 48 },
        { key: "plumbing", median: 10, p90: 58 },
        { key: "repairs", median: 11, p90: 69 },
        { key: "electricGas", median: 7, p90: 50 },
        { key: "buildingSafety", median: 1, p90: 14 },
      ],
    },
    {
      label: "Block Quality",
      radiusMeters: 350,
      colorVar: "--series-block",
      buckets: [
        { key: "noise", median: 998, p90: 3969 },
        { key: "parking", median: 1329, p90: 2817 },
        { key: "streetCondition", median: 108, p90: 225 },
        { key: "sanitation", median: 310, p90: 706 },
        { key: "infrastructure", median: 310, p90: 631 },
        { key: "publicSafety", median: 65, p90: 474 },
      ],
    },
  ],
};
