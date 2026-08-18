import { describe, it, expect } from "vitest";
import {
  BUILDING_HEALTH_TYPES,
  BLOCK_QUALITY_TYPES,
  RADIUS_TIERS,
  BUCKET_NAMES,
  TYPE_TO_BUCKET,
  ALL_COMPLAINT_TYPES,
  BUCKET_WEIGHTS,
  WINDOW_MONTHS,
  windowCutoffISO,
  NYC_BOUNDS,
  CACHE_COORD_PRECISION,
  STATUS_TO_BUCKET,
  STATUS_BUCKET_NAMES,
  statusBucket,
} from "../src/config/constants.js";

// These tests guard the decisions recorded in CLAUDE.md. A failure here usually
// means someone edited a type list without updating the spec — which is exactly
// the silent-reweighting failure mode CLAUDE.md decision 6 warns about.

describe("bucket definitions", () => {
  it("keeps exactly three buckets per sub-score", () => {
    expect(BUCKET_NAMES.building).toEqual([
      "heatHotWater",
      "unsanitaryCondition",
      "plumbing",
    ]);
    expect(BUCKET_NAMES.block).toEqual(["noise", "parking", "streetCondition"]);
  });

  it("excludes the types CLAUDE.md explicitly rejected", () => {
    // Each of these was excluded for a documented reason; re-adding one silently
    // changes what the score means.
    const excluded = [
      "Dirty Condition",
      "Dirty Conditions",
      "General Construction/Plumbing",
      "Non-Residential Heat",
      "Noise",
      "Noise - Helicopter",
      "Noise - Park",
      "Noise - House of Worship",
    ];
    for (const type of excluded) {
      expect(TYPE_TO_BUCKET[type], `${type} must stay excluded`).toBeUndefined();
    }
  });

  it("folds Blocked Driveway into parking and Sidewalk Condition into streetCondition", () => {
    expect(TYPE_TO_BUCKET["Blocked Driveway"]).toBe("parking");
    expect(TYPE_TO_BUCKET["Sidewalk Condition"]).toBe("streetCondition");
  });
});

describe("TYPE_TO_BUCKET", () => {
  it("maps every declared string variant to its bucket", () => {
    const declared = Object.entries({
      ...BUILDING_HEALTH_TYPES,
      ...BLOCK_QUALITY_TYPES,
    });
    for (const [bucket, types] of declared) {
      for (const type of types) {
        expect(TYPE_TO_BUCKET[type]).toBe(bucket);
      }
    }
  });

  it("has no string claimed by two buckets", () => {
    // Object.fromEntries silently keeps the last write, so a duplicated string
    // would reassign a bucket without any error. Count them instead.
    const allStrings = Object.values(RADIUS_TIERS).flatMap(({ buckets }) =>
      Object.values(buckets).flat()
    );
    expect(allStrings.length).toBe(new Set(allStrings).size);
    expect(ALL_COMPLAINT_TYPES.length).toBe(allStrings.length);
  });

  it("covers every type used in the `in (...)` clause", () => {
    for (const type of ALL_COMPLAINT_TYPES) {
      expect(TYPE_TO_BUCKET[type]).toBeTypeOf("string");
    }
  });
});

describe("radius tiers", () => {
  it("uses the tight/wide radii chosen in M0", () => {
    expect(RADIUS_TIERS.building.radiusMeters).toBe(25);
    expect(RADIUS_TIERS.block.radiusMeters).toBe(350);
  });

  it("keeps tier keys and their `tier` fields in sync", () => {
    for (const [name, tier] of Object.entries(RADIUS_TIERS)) {
      expect(tier.tier).toBe(name);
    }
  });
});

describe("BUCKET_WEIGHTS", () => {
  it("has an entry for every bucket, so a reweight cannot be silently partial", () => {
    const allBuckets = [...BUCKET_NAMES.building, ...BUCKET_NAMES.block];
    expect(Object.keys(BUCKET_WEIGHTS).sort()).toEqual([...allBuckets].sort());
  });
});

describe("windowCutoffISO", () => {
  it("returns a floating Socrata timestamp (no timezone suffix)", () => {
    const cutoff = windowCutoffISO(new Date("2026-08-15T12:00:00Z"));
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(cutoff.endsWith("Z")).toBe(false);
  });

  it("goes back exactly WINDOW_MONTHS", () => {
    expect(windowCutoffISO(new Date("2026-08-15T00:00:00Z"))).toBe(
      "2024-08-15T00:00:00"
    );
  });

  it("does not reach below the 2020-01-01 dataset floor", () => {
    // CLAUDE.md item 4: the dataset starts 2020-01-01, so a window longer than
    // ~68 months would truncate silently rather than error.
    expect(WINDOW_MONTHS).toBeLessThanOrEqual(68);
    expect(new Date(windowCutoffISO(new Date())).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00").getTime()
    );
  });

  it("does not mutate the caller's date", () => {
    const now = new Date("2026-08-15T00:00:00Z");
    windowCutoffISO(now);
    expect(now.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("misc config", () => {
  it("bounds a box that contains all five boroughs", () => {
    const boroughs = [
      [40.7484, -73.9857], // Manhattan
      [40.6782, -73.9442], // Brooklyn
      [40.7282, -73.7949], // Queens
      [40.8448, -73.8648], // Bronx
      [40.5795, -74.1502], // Staten Island
    ];
    for (const [lat, lng] of boroughs) {
      expect(lat).toBeGreaterThanOrEqual(NYC_BOUNDS.minLat);
      expect(lat).toBeLessThanOrEqual(NYC_BOUNDS.maxLat);
      expect(lng).toBeGreaterThanOrEqual(NYC_BOUNDS.minLng);
      expect(lng).toBeLessThanOrEqual(NYC_BOUNDS.maxLng);
    }
  });

  it("rounds cache coords finely enough not to merge neighbouring buildings", () => {
    // 4dp is ~11m, comfortably under the 25m building radius.
    expect(CACHE_COORD_PRECISION).toBe(4);
  });
});

describe("status buckets", () => {
  // The eight values confirmed against the live dataset 2026-08-17. If a query
  // ever returns a ninth, statusBucket's fallback is what keeps it visible.
  const CONFIRMED = [
    "Closed",
    "In Progress",
    "Open",
    "Pending",
    "Assigned",
    "Started",
    "Unspecified",
    "Cancel",
  ];

  it("maps every status the live dataset returns", () => {
    for (const status of CONFIRMED) {
      expect(STATUS_BUCKET_NAMES).toContain(statusBucket(status));
    }
  });

  it("files Assigned and Started under in-progress, not open", () => {
    // The frontend's old mapStatus() got this wrong, which is why the mapping
    // now lives here and has exactly one definition.
    expect(statusBucket("Assigned")).toBe("in-progress");
    expect(statusBucket("Started")).toBe("in-progress");
    expect(statusBucket("Pending")).toBe("in-progress");
  });

  it("treats Cancel as terminal", () => {
    expect(statusBucket("Cancel")).toBe("closed");
    expect(statusBucket("Closed")).toBe("closed");
  });

  // Unspecified carries no evidence anyone acted. Claiming progress we cannot
  // evidence is the worse error for someone deciding on a lease.
  it("treats Unspecified as open rather than in-progress", () => {
    expect(statusBucket("Unspecified")).toBe("open");
  });

  it("defaults an unknown or missing status to open instead of dropping it", () => {
    expect(statusBucket("Some Future Status")).toBe("open");
    expect(statusBucket(undefined)).toBe("open");
    expect(statusBucket(null)).toBe("open");
  });

  it("offers exactly the three buckets the UI filters on", () => {
    expect(STATUS_BUCKET_NAMES).toEqual(["open", "in-progress", "closed"]);
  });

  it("maps only into those three buckets", () => {
    for (const bucket of Object.values(STATUS_TO_BUCKET)) {
      expect(STATUS_BUCKET_NAMES).toContain(bucket);
    }
  });
});
