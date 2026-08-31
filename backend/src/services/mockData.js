import {
  BUCKET_NAMES,
  TYPE_TO_BUCKET,
  CACHE_COORD_PRECISION,
  WINDOW_MONTHS,
  AMENITY_TIERS,
  AMENITY_BUCKET_NAMES,
  AMENITY_MAX_METERS,
} from "../config/constants.js";
import { buildReport } from "./scoring.js";
import { explainFromTemplate, explainOverallFromTemplate } from "./explain.js";

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

/**
 * A plausible stand-in amenity baseline, same spirit as MOCK_BASELINE above —
 * not the real scripts/buildAmenityBaseline.js output, just the right order
 * of magnitude (metres, not counts) so mocked amenity scores land across all
 * three bands.
 */
const MOCK_AMENITY_BASELINE = {
  _id: "mock",
  source: "mock",
  perBucket: Object.fromEntries(
    Object.values(AMENITY_BUCKET_NAMES)
      .flat()
      .map((bucket) => [bucket, { median: 300, p90: 1200, zeroShare: 0 }])
  ),
};

/**
 * Deterministic amenity metrics for one tier. Distances skew low (the SAME
 * direction as mockCounts' skew toward few complaints) — for a distance
 * metric, low is the "good" end too, so this keeps the mock's band spread
 * consistent with the complaint tiers' rather than accidentally inverted.
 *
 * `name` is an obviously-synthetic placeholder, never a real-looking station
 * or park name — this is mock data, and CLAUDE.md's rule against showing
 * fabricated content as if it were real applies here as much as it does to
 * the showcase carousel.
 */
function mockAmenityMetrics(lat, lng, tierName) {
  const { buckets, radiusMeters } = AMENITY_TIERS[tierName];
  const metrics = {};
  for (const bucket of buckets) {
    const rand = seededRandom(seedFor(lat, lng, `amenity:${bucket}`));
    const meters = Math.round(rand() ** 2.5 * AMENITY_MAX_METERS);
    const withinRand = seededRandom(seedFor(lat, lng, `amenity-within:${bucket}`));
    metrics[bucket] = {
      meters,
      within: meters <= radiusMeters ? 1 + Math.floor(withinRand() * 4) : 0,
      name: meters < AMENITY_MAX_METERS ? `Mock ${bucket}` : null,
    };
  }
  return metrics;
}

/**
 * Deterministic status breakdown for one tier's mock bucket counts — the mock
 * analogue of fetchCountsForTier's `bucketStatusCounts`, so the mock path
 * exercises the same status-segmented bar the live path does.
 *
 * Each bucket's total is split into open/in-progress/closed by drawing two
 * random cut points and never independently, which is what guarantees the
 * three parts sum EXACTLY back to that bucket's count — if they didn't, the
 * frontend's bar segments would not add up to the total already shown for the
 * category.
 */
function mockBucketStatusCounts(lat, lng, tierName, counts) {
  const result = {};
  for (const bucket of BUCKET_NAMES[tierName]) {
    const total = counts[bucket] ?? 0;
    if (total <= 0) {
      result[bucket] = { open: 0, "in-progress": 0, closed: 0 };
      continue;
    }
    const rand = seededRandom(seedFor(lat, lng, `status:${tierName}:${bucket}`));
    const a = Math.floor(rand() * (total + 1));
    const b = Math.floor(rand() * (total + 1));
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    result[bucket] = { open: lo, "in-progress": hi - lo, closed: total - hi };
  }
  return result;
}

/** Mocked POST /api/score payload. `address` is always null — we do not geocode. */
export function mockScoreReport(lat, lng) {
  const amenities = Object.fromEntries(
    Object.keys(AMENITY_TIERS).map((tier) => [tier, mockAmenityMetrics(lat, lng, tier)])
  );

  const buildingCounts = mockCounts(lat, lng, "building", 12);
  const blockCounts = mockCounts(lat, lng, "block", 2600);
  const statusCounts = {
    building: mockBucketStatusCounts(lat, lng, "building", buildingCounts),
    block: mockBucketStatusCounts(lat, lng, "block", blockCounts),
  };

  const report = buildReport(
    { building: buildingCounts, block: blockCounts },
    MOCK_BASELINE,
    { mock: true, windowMonths: WINDOW_MONTHS },
    amenities,
    MOCK_AMENITY_BASELINE,
    statusCounts
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
  report.transitAccess = {
    ...report.transitAccess,
    ...explainFromTemplate("transit", report.transitAccess),
  };
  report.parksAccess = {
    ...report.parksAccess,
    ...explainFromTemplate("parks", report.parksAccess),
  };
  report.bikeAccess = {
    ...report.bikeAccess,
    ...explainFromTemplate("bike", report.bikeAccess),
  };
  report.walkabilityAccess = {
    ...report.walkabilityAccess,
    ...explainFromTemplate("walkability", report.walkabilityAccess),
  };

  report.summary = explainOverallFromTemplate(report);

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
