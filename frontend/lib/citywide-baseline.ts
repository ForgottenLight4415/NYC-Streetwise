/**
 * The citywide 311 baseline every score is measured against.
 *
 * COPIED FROM backend/src/config/baseline.json — the committed output of
 * `npm run baseline`, computed over 251 coordinates sampled across the five
 * boroughs with a minimum share per borough. If that file is ever rebuilt, these
 * numbers must be re-copied or the homepage will describe an older city than the
 * scores do.
 *
 * Copied rather than fetched deliberately: this is what the homepage falls back
 * to when the score cache is cold, so it cannot itself depend on the backend
 * being reachable. It is real measured data either way — the point of showing it
 * is that a page with nothing cached still has something true to say.
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
  sampleSize: 251,
  version: "v1",
  tiers: [
    {
      label: "Building Health",
      radiusMeters: 25,
      colorVar: "--series-building",
      buckets: [
        { key: "heatHotWater", median: 30, p90: 245 },
        { key: "unsanitaryCondition", median: 12, p90: 54 },
        { key: "plumbing", median: 7, p90: 34 },
      ],
    },
    {
      label: "Block Quality",
      radiusMeters: 350,
      colorVar: "--series-block",
      buckets: [
        { key: "noise", median: 1121, p90: 3289 },
        { key: "parking", median: 1120, p90: 2639 },
        { key: "streetCondition", median: 121, p90: 273 },
      ],
    },
  ],
};
