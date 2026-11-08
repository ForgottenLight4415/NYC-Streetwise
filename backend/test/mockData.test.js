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
  // mockScoreReport returns the same top-level keys, per-tier bucket keys and radii as a live report, flags meta.mock, and names mock amenities "Mock ...".
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

  // mockScoreReport gives integer building and block scores from 0 to 100 with a valid band and non-negative integer counts.
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

  // mockScoreReport returns an identical report for the same coordinate.
  it("is deterministic per coordinate", () => {
    // The whole point of the mock: the same address must always give the same
    // report, or frontend work becomes impossible to eyeball.
    expect(mockScoreReport(...TIMES_SQUARE)).toEqual(
      mockScoreReport(...TIMES_SQUARE)
    );
  });

});

describe("mockComplaints", () => {
  // mockComplaints returns points with exactly the contract keys, a known complaint type, finite coordinates and a parseable date.
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

  // mockComplaints keeps every point within the requested radius of the origin.
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

  // mockComplaints dates every point inside the trailing ~731-day window and not in the future.
  it("dates all points inside the trailing window", () => {
    const now = Date.now();
    const windowStart = now - 731 * 24 * 60 * 60 * 1000;
    for (const point of mockComplaints(...TIMES_SQUARE, 350)) {
      const t = Date.parse(point.created_date);
      expect(t).toBeGreaterThanOrEqual(windowStart);
      expect(t).toBeLessThanOrEqual(now + 1000);
    }
  });

  // mockComplaints is deterministic for a given coordinate and radius, and differs between locations.
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

  // mockMonthlyTrend returns {month, count} points, oldest first, YYYY-MM formatted, with positive integer counts only.
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

  // mockMonthlyTrend never spans more months than requested.
  it("never returns more months than requested", () => {
    const points = mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS);
    const monthsSpanned =
      (2026 - Number(points[0].month.slice(0, 4))) * 12 +
      (6 - Number(points[0].month.slice(5)));
    expect(monthsSpanned).toBeLessThan(OPTS.months);
  });

  // mockMonthlyTrend is deterministic for a given coordinate, tier and radius, and differs between locations.
  it("is deterministic per coordinate, tier, and radius", () => {
    expect(mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)).toEqual(
      mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)
    );
    expect(mockMonthlyTrend(...TIMES_SQUARE, 350, OPTS)).not.toEqual(
      mockMonthlyTrend(...BUSHWICK, 350, OPTS)
    );
  });

});
