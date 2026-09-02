import { describe, it, expect } from "vitest";
import {
  mockScoreReport,
  mockComplaints,
  mockMonthlyTrend,
} from "../src/services/mockData.js";
import {
  BUCKET_NAMES,
  RADIUS_TIERS,
  TYPE_TO_BUCKET,
  AMENITY_TIERS,
  AMENITY_BUCKET_NAMES,
} from "../src/config/constants.js";

const TIMES_SQUARE = [40.7580, -73.9855];
const BUSHWICK = [40.6944, -73.9213];

describe("mockScoreReport", () => {
  it("returns the frozen contract shape", () => {
    const report = mockScoreReport(...TIMES_SQUARE);

    expect(Object.keys(report).sort()).toEqual([
      "address",
      "bikeAccess",
      "blockQuality",
      "buildingHealth",
      "meta",
      "parksAccess",
      "summary",
      "transitAccess",
      "walkabilityAccess",
    ]);
    expect(report.address).toBeNull(); // we never geocode
    // Mock mode must be obvious from the payload — nobody should demo mock
    // numbers believing they are live 311 data.
    expect(report.meta.mock).toBe(true);

    expect(Object.keys(report.buildingHealth.counts).sort()).toEqual(
      [...BUCKET_NAMES.building].sort()
    );
    expect(Object.keys(report.blockQuality.counts).sort()).toEqual(
      [...BUCKET_NAMES.block].sort()
    );
    expect(report.buildingHealth.radiusMeters).toBe(
      RADIUS_TIERS.building.radiusMeters
    );
    expect(report.blockQuality.radiusMeters).toBe(RADIUS_TIERS.block.radiusMeters);

    // Mock mode's amenity sections must be present too — this test exists so
    // mock and live payload shapes cannot silently drift apart, and that
    // guarantee is only as good as this file actually checking every key.
    for (const [tier, reportKey] of [
      ["transit", "transitAccess"],
      ["parks", "parksAccess"],
      ["bike", "bikeAccess"],
      ["walkability", "walkabilityAccess"],
    ]) {
      expect(Object.keys(report[reportKey].metrics).sort()).toEqual(
        [...AMENITY_BUCKET_NAMES[tier]].sort()
      );
      expect(report[reportKey].radiusMeters).toBe(AMENITY_TIERS[tier].radiusMeters);
      // Mock amenity names must be obviously synthetic, never real-looking —
      // same rule as the "never show fabricated content as real" principle
      // CLAUDE.md applies to the showcase carousel.
      for (const metric of Object.values(report[reportKey].metrics)) {
        if (metric.name !== null) expect(metric.name).toMatch(/^Mock /);
      }
    }
  });

  it("produces scores in range with a matching band", () => {
    for (const sub of [
      mockScoreReport(...TIMES_SQUARE).buildingHealth,
      mockScoreReport(...TIMES_SQUARE).blockQuality,
    ]) {
      expect(sub.score).toBeGreaterThanOrEqual(0);
      expect(sub.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(sub.score)).toBe(true);
      expect(["good", "fair", "poor"]).toContain(sub.band);
      for (const count of Object.values(sub.counts)) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("is deterministic per coordinate", () => {
    // The whole point of the mock: the same address must always give the same
    // report, or frontend work becomes impossible to eyeball.
    expect(mockScoreReport(...TIMES_SQUARE)).toEqual(
      mockScoreReport(...TIMES_SQUARE)
    );
  });

  it("gives visibly different reports for different coordinates", () => {
    expect(mockScoreReport(...TIMES_SQUARE)).not.toEqual(
      mockScoreReport(...BUSHWICK)
    );
  });

  it("collapses coordinates that round to the same cache key", () => {
    // 4dp rounding is the cache key; the mock keys off the same rounding so the
    // mock's cache-hit behaviour matches the real one's.
    expect(mockScoreReport(40.75801, -73.98551)).toEqual(
      mockScoreReport(40.75804, -73.98553)
    );
  });

  it("spans all three bands across coordinates", () => {
    // A mock that only ever returns "fair" hides two thirds of the frontend's
    // states. The mock baseline exists to keep all three reachable.
    const bands = new Set();
    for (let i = 0; i < 200; i++) {
      const report = mockScoreReport(40.7 + i * 0.0007, -73.95 - i * 0.0007);
      bands.add(report.buildingHealth.band);
      bands.add(report.blockQuality.band);
    }
    expect([...bands].sort()).toEqual(["fair", "good", "poor"]);
  });

  it("uses different draws for the two tiers", () => {
    // A shared seed would make building and block counts suspiciously correlated.
    const report = mockScoreReport(...BUSHWICK);
    expect(Object.values(report.buildingHealth.counts)).not.toEqual(
      Object.values(report.blockQuality.counts).slice(0, 3)
    );
  });
});

describe("mockComplaints", () => {
  it("returns points in the contract shape", () => {
    const points = mockComplaints(...TIMES_SQUARE, 350);
    expect(points.length).toBeGreaterThan(0);

    for (const point of points) {
      expect(Object.keys(point).sort()).toEqual([
        "created_date",
        "lat",
        "lng",
        "status",
        "type",
      ]);
      expect(TYPE_TO_BUCKET[point.type]).toBeTypeOf("string");
      expect(Number.isFinite(point.lat)).toBe(true);
      expect(Number.isFinite(point.lng)).toBe(true);
      expect(Number.isNaN(Date.parse(point.created_date))).toBe(false);
    }
  });

  it("keeps every point inside the requested radius", () => {
    const [lat, lng] = TIMES_SQUARE;
    const radius = 350;
    for (const point of mockComplaints(lat, lng, radius)) {
      const dLat = (point.lat - lat) * 111320;
      const dLng =
        (point.lng - lng) * 111320 * Math.cos((lat * Math.PI) / 180);
      const distance = Math.hypot(dLat, dLng);
      // Allow 1m of float slack on the metres<->degrees round trip.
      expect(distance).toBeLessThanOrEqual(radius + 1);
    }
  });

  it("dates all points inside the trailing window", () => {
    const now = Date.now();
    const windowStart = now - 731 * 24 * 60 * 60 * 1000;
    for (const point of mockComplaints(...TIMES_SQUARE, 350)) {
      const t = Date.parse(point.created_date);
      expect(t).toBeGreaterThanOrEqual(windowStart);
      expect(t).toBeLessThanOrEqual(now + 1000);
    }
  });

  it("scales point count with radius but stays capped", () => {
    const small = mockComplaints(...TIMES_SQUARE, 25);
    const large = mockComplaints(...TIMES_SQUARE, 350);
    expect(large.length).toBeGreaterThan(small.length);
    expect(mockComplaints(...TIMES_SQUARE, 2000).length).toBeLessThanOrEqual(400);
  });

  it("is deterministic per coordinate and radius", () => {
    expect(mockComplaints(...TIMES_SQUARE, 350)).toEqual(
      mockComplaints(...TIMES_SQUARE, 350)
    );
    expect(mockComplaints(...TIMES_SQUARE, 350)).not.toEqual(
      mockComplaints(...BUSHWICK, 350)
    );
  });
});

describe("mockMonthlyTrend", () => {
  const OPTS = { tier: "block", months: 9, now: new Date("2026-06-15") };

  it("returns points in the contract shape, oldest first, only non-zero months", () => {
    const points = mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS);
    expect(points.length).toBeGreaterThan(0);

    let previousMonth = "";
    for (const point of points) {
      expect(Object.keys(point).sort()).toEqual(["count", "month"]);
      expect(point.month).toMatch(/^\d{4}-\d{2}$/);
      expect(point.month > previousMonth).toBe(true);
      previousMonth = point.month;
      expect(Number.isInteger(point.count)).toBe(true);
      expect(point.count).toBeGreaterThan(0);
    }
  });

  it("never returns more months than requested", () => {
    const points = mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS);
    const monthsSpanned =
      (2026 - Number(points[0].month.slice(0, 4))) * 12 +
      (6 - Number(points[0].month.slice(5)));
    expect(monthsSpanned).toBeLessThan(OPTS.months);
  });

  it("scales the block tier's counts above the building tier's", () => {
    // Block-tier radii cover far more ground, so they must carry far more
    // complaints — this is what makes the mock trend chart look like real
    // 311 volume instead of two visually identical tiers.
    const buildingTotal = mockMonthlyTrend(...TIMES_SQUARE, 25, {
      ...OPTS,
      tier: "building",
    }).reduce((sum, p) => sum + p.count, 0);
    const blockTotal = mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS).reduce(
      (sum, p) => sum + p.count,
      0
    );
    expect(blockTotal).toBeGreaterThan(buildingTotal);
  });

  it("is deterministic per coordinate, tier, and radius", () => {
    expect(mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)).toEqual(
      mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)
    );
    expect(mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)).not.toEqual(
      mockMonthlyTrend(...BUSHWICK, 350, OPTS)
    );
  });

  it("uses a different draw per tier, not a shared seed", () => {
    // Same coordinate and radius, only the tier differs — a shared seed would
    // make the two series suspiciously identical in shape.
    const building = mockMonthlyTrend(...TIMES_SQUARE, 350, {
      ...OPTS,
      tier: "building",
    });
    const block = mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS);
    expect(building).not.toEqual(block);
  });
});
