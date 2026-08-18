import {
  BUCKET_NAMES,
  TYPE_TO_BUCKET,
  CACHE_COORD_PRECISION,
  WINDOW_MONTHS,
} from "../config/constants.js";
import { buildReport } from "./scoring.js";
import { explainFromTemplate } from "./explain.js";

// Mock data. Started as the P0 stand-in that unblocked the frontend; after M5
// it is opt-in via USE_MOCK_DATA=1 and exists for offline frontend work — no
// Socrata token, no Mongo, no network. Nothing here should grow business logic.
//
// It generates COUNTS only and hands them to the real scorer, so the mock and
// the live path differ in exactly one place: where the counts came from. A mock
// that computed its own scores would drift out of shape the first time the
// contract moved, which is the whole failure it is supposed to prevent.
//
// Values are DERIVED FROM THE COORDINATE, not random: the same address always
// returns the same report, and two different addresses return visibly different
// reports. Random mocks make frontend work miserable to eyeball.

/** Small deterministic string hash (FNV-1a), used as a seeded PRNG source. */
function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Mulberry32 — tiny seeded PRNG returning floats in [0, 1). */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(lat, lng, salt) {
  const key = `${lat.toFixed(CACHE_COORD_PRECISION)},${lng.toFixed(
    CACHE_COORD_PRECISION
  )},${salt}`;
  return hashString(key);
}

/**
 * Deterministic bucket counts for one tier. `maxCount` differs per tier because
 * a 25m circle sees far fewer complaints than a 350m one — keeping the
 * magnitudes plausible matters for frontend layout.
 */
function mockCounts(lat, lng, tierName, maxCount) {
  const rand = seededRandom(seedFor(lat, lng, tierName));
  const counts = {};
  for (const bucket of BUCKET_NAMES[tierName]) {
    // Skewed toward the low end rather than uniform, for two reasons: real 311
    // counts are long-tailed (most locations are quiet, a few are terrible),
    // and a uniform draw against a realistic baseline lands almost everything
    // above the median, so the mock never produces a "good" band and the
    // frontend never sees that state.
    counts[bucket] = Math.floor(rand() ** 2.5 * maxCount);
  }
  return counts;
}

/**
 * A plausible stand-in baseline, NOT the real one — the real baseline lives in
 * src/config/baseline.json and is loaded from Mongo or disk on the live path.
 * Hardcoded here so mock mode needs no file, no Mongo, and no network at all.
 * The numbers only have to be the right order of magnitude for the mocked
 * scores to land across all three bands.
 */
const MOCK_BASELINE = {
  _id: "mock",
  source: "mock",
  perBucket: {
    heatHotWater: { median: 2, p90: 20 },
    unsanitaryCondition: { median: 1, p90: 8 },
    plumbing: { median: 1, p90: 6 },
    noise: { median: 400, p90: 2500 },
    parking: { median: 350, p90: 1600 },
    streetCondition: { median: 60, p90: 260 },
  },
};

/** Mocked POST /api/score payload. `address` is always null — we do not geocode. */
export function mockScoreReport(lat, lng) {
  const report = buildReport(
    {
      building: mockCounts(lat, lng, "building", 12),
      block: mockCounts(lat, lng, "block", 2600),
    },
    MOCK_BASELINE,
    { mock: true, windowMonths: WINDOW_MONTHS }
  );

  // Template explanations, exactly as the live path serves on a cache miss —
  // so the frontend's "template now, swap in AI later" flow is exercisable with
  // no AI provider running at all.
  report.buildingHealth = {
    ...report.buildingHealth,
    ...explainFromTemplate("building", report.buildingHealth),
  };
  report.blockQuality = {
    ...report.blockQuality,
    ...explainFromTemplate("block", report.blockQuality),
  };

  return report;
}

const ALL_TYPES = Object.keys(TYPE_TO_BUCKET);
const STATUSES = ["Open", "Closed", "In Progress"];

/**
 * Mocked GET /api/complaints payload: individual points scattered inside the
 * requested circle, for the frontend heatmap.
 */
export function mockComplaints(lat, lng, radiusMeters) {
  const rand = seededRandom(seedFor(lat, lng, `complaints:${radiusMeters}`));
  // Scale point count with area so the heatmap density looks believable.
  const pointCount = Math.min(400, Math.round((radiusMeters / 25) * 8));

  // Meters -> degrees. Longitude degrees shrink with latitude, hence the cosine.
  const latDegPerMeter = 1 / 111320;
  const lngDegPerMeter = 1 / (111320 * Math.cos((lat * Math.PI) / 180));

  // Quantized to the UTC day, not Date.now(): otherwise two calls milliseconds
  // apart return different created_dates and the mock stops being deterministic
  // per coordinate — the one property the frontend relies on.
  const now = new Date().setUTCHours(0, 0, 0, 0);
  const twoYearsMs = 730 * 24 * 60 * 60 * 1000;

  return Array.from({ length: pointCount }, () => {
    // sqrt keeps points uniform over the disc instead of clumping at the center.
    const distance = radiusMeters * Math.sqrt(rand());
    const angle = rand() * 2 * Math.PI;

    return {
      type: ALL_TYPES[Math.floor(rand() * ALL_TYPES.length)],
      lat: lat + distance * Math.sin(angle) * latDegPerMeter,
      lng: lng + distance * Math.cos(angle) * lngDegPerMeter,
      created_date: new Date(now - rand() * twoYearsMs).toISOString(),
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    };
  });
}

/**
 * Deterministic monthly counts for one tier, mirroring what
 * providers/socrata.js `fetchMonthlyTrend` returns: only months that actually
 * have complaints, "YYYY-MM" keys, oldest first. The caller zero-fills.
 *
 * Seeded per coordinate + tier + window so a given address always charts the
 * same shape, and shaped with a mild seasonal swell so the demo chart reads
 * like complaint data rather than noise.
 */
export function mockMonthlyTrend(lat, lng, radiusMeters, { tier, months, now } = {}) {
  const rand = seededRandom(seedFor(lat, lng, `trend:${tier}:${radiusMeters}`));
  const reference = new Date(now ?? Date.now());
  // Block-tier radii cover far more ground, so they carry far more complaints.
  const scale = radiusMeters >= 200 ? 40 : 2;

  const points = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
    // Winter peak: heat complaints spike Dec-Mar, and the block tier's noise
    // runs the other way, so this is a gentle swell rather than a hard curve.
    const seasonal = 1 + 0.45 * Math.cos((d.getMonth() / 12) * 2 * Math.PI);
    const count = Math.round(rand() * scale * seasonal);
    if (count > 0) {
      points.push({
        month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        count,
      });
    }
  }
  return points;
}
