import { describe, it, expect } from "vitest";
import {
  BUILDING_HEALTH_TYPES,
  RADIUS_TIERS,
  BUCKET_NAMES,
  TYPE_TO_BUCKET,
  ALL_COMPLAINT_TYPES,
  BUCKET_WEIGHTS,
  WINDOW_MONTHS,
  windowCutoffISO,
  NYC_BOUNDS,
  STATUS_TO_BUCKET,
  STATUS_BUCKET_NAMES,
  statusBucket,
  AMENITY_TIERS,
  AMENITY_ROUTE_CANDIDATES,
  AMENITY_ROUTE_ELEMENTS_PER_CALL,
  AMENITY_BASELINE_ROUTE_PACING_MS,
  GOOGLE_ROUTES_ELEMENTS_PER_MINUTE,
  GOOGLE_ROUTES_QUOTA_UTILISATION,
} from "../src/config/constants.js";

// These tests guard the decisions recorded in CLAUDE.md. A failure here usually
// means someone edited a type list without updating the spec — which is exactly
// the silent-reweighting failure mode CLAUDE.md decision 6 warns about.

describe("bucket definitions", () => {
  // TYPE_TO_BUCKET has no entry for the complaint types deliberately excluded (Dirty Conditions, Lead, generic Noise, helicopter noise, and so on).
  it("excludes the types CLAUDE.md explicitly rejected", () => {
    // Each of these was excluded for a documented reason; re-adding one silently
    // changes what the score means.
    const excluded = [
      "Dirty Conditions",
      "General Construction/Plumbing",
      "Illegal Fireworks",
      "Urinating in Public",
      "Indoor Air Quality",
      "Lead",
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

  // TYPE_TO_BUCKET maps Blocked Driveway to parking and Sidewalk Condition to streetCondition.
  it("folds Blocked Driveway into parking and Sidewalk Condition into streetCondition", () => {
    expect(TYPE_TO_BUCKET["Blocked Driveway"]).toBe("parking");
    expect(TYPE_TO_BUCKET["Sidewalk Condition"]).toBe("streetCondition");
  });

  // TYPE_TO_BUCKET maps WATER LEAK to plumbing, and Abandoned Vehicle and Derelict Vehicles to parking.
  it("folds Water Leak into plumbing and abandoned vehicles into parking", () => {
    expect(TYPE_TO_BUCKET["WATER LEAK"]).toBe("plumbing");
    expect(TYPE_TO_BUCKET["Abandoned Vehicle"]).toBe("parking");
    expect(TYPE_TO_BUCKET["Derelict Vehicles"]).toBe("parking");
  });

  // Dirty Condition maps to the block sanitation bucket and is not in the building unsanitaryCondition list.
  it("counts Dirty Condition on the block, never against a building", () => {
    // DSNY street sanitation: a block condition, not an HPD building-interior
    // one (CLAUDE.md decision 1).
    expect(TYPE_TO_BUCKET["Dirty Condition"]).toBe("sanitation");
    expect(BUILDING_HEALTH_TYPES.unsanitaryCondition).not.toContain("Dirty Condition");
  });
});

describe("TYPE_TO_BUCKET", () => {
  // No complaint type string appears in more than one bucket, and ALL_COMPLAINT_TYPES has no duplicates.
  it("has no string claimed by two buckets", () => {
    // Object.fromEntries silently keeps the last write, so a duplicated string
    // would reassign a bucket without any error. Count them instead.
    const allStrings = Object.values(RADIUS_TIERS).flatMap(({ buckets }) =>
      Object.values(buckets).flat()
    );
    expect(allStrings.length).toBe(new Set(allStrings).size);
    expect(ALL_COMPLAINT_TYPES.length).toBe(allStrings.length);
  });
});

describe("BUCKET_WEIGHTS", () => {
  // BUCKET_WEIGHTS has an entry for every building and block bucket and no others.
  it("has an entry for every bucket, so a reweight cannot be silently partial", () => {
    const allBuckets = [...BUCKET_NAMES.building, ...BUCKET_NAMES.block];
    expect(Object.keys(BUCKET_WEIGHTS).sort()).toEqual([...allBuckets].sort());
  });
});

describe("windowCutoffISO", () => {
  // windowCutoffISO returns a timezone-less ISO timestamp suitable for Socrata.
  it("returns a floating Socrata timestamp (no timezone suffix)", () => {
    const cutoff = windowCutoffISO(new Date("2026-08-15T12:00:00Z"));
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(cutoff.endsWith("Z")).toBe(false);
  });

  // windowCutoffISO goes back exactly WINDOW_MONTHS (two years from 2026-08-15 gives 2024-08-15).
  it("goes back exactly WINDOW_MONTHS", () => {
    expect(windowCutoffISO(new Date("2026-08-15T00:00:00Z"))).toBe(
      "2024-08-15T00:00:00"
    );
  });

  // WINDOW_MONTHS is at most 68 and the cutoff stays after the dataset's 2020-01-01 start.
  it("does not reach below the 2020-01-01 dataset floor", () => {
    // CLAUDE.md item 4: the dataset starts 2020-01-01, so a window longer than
    // ~68 months would truncate silently rather than error.
    expect(WINDOW_MONTHS).toBeLessThanOrEqual(68);
    expect(new Date(windowCutoffISO(new Date())).getTime()).toBeGreaterThan(
      new Date("2020-01-01T00:00:00").getTime()
    );
  });

  // windowCutoffISO does not mutate the Date passed in.
  it("does not mutate the caller's date", () => {
    const now = new Date("2026-08-15T00:00:00Z");
    windowCutoffISO(now);
    expect(now.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("misc config", () => {
  // NYC_BOUNDS contains a representative point from each of the five boroughs.
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

  // statusBucket maps every status value the live dataset returns into one of the three UI buckets.
  it("maps every status the live dataset returns", () => {
    for (const status of CONFIRMED) {
      expect(STATUS_BUCKET_NAMES).toContain(statusBucket(status));
    }
  });

  // statusBucket maps Assigned, Started and Pending to in-progress.
  it("files Assigned and Started under in-progress, not open", () => {
    // The frontend's old mapStatus() got this wrong, which is why the mapping
    // now lives here and has exactly one definition.
    expect(statusBucket("Assigned")).toBe("in-progress");
    expect(statusBucket("Started")).toBe("in-progress");
    expect(statusBucket("Pending")).toBe("in-progress");
  });

  // statusBucket maps Cancel and Closed to closed.
  it("treats Cancel as terminal", () => {
    expect(statusBucket("Cancel")).toBe("closed");
    expect(statusBucket("Closed")).toBe("closed");
  });

  // Unspecified carries no evidence anyone acted. Claiming progress we cannot
  // evidence is the worse error for someone deciding on a lease.
  // statusBucket maps Unspecified to open, not in-progress.
  it("treats Unspecified as open rather than in-progress", () => {
    expect(statusBucket("Unspecified")).toBe("open");
  });

  // statusBucket defaults unknown, undefined or null statuses to open.
  it("defaults an unknown or missing status to open instead of dropping it", () => {
    expect(statusBucket("Some Future Status")).toBe("open");
    expect(statusBucket(undefined)).toBe("open");
    expect(statusBucket(null)).toBe("open");
  });

  // Every value in STATUS_TO_BUCKET is one of the three STATUS_BUCKET_NAMES.
  it("maps only into those three buckets", () => {
    for (const bucket of Object.values(STATUS_TO_BUCKET)) {
      expect(STATUS_BUCKET_NAMES).toContain(bucket);
    }
  });
});

describe("Google Routes quota pacing", () => {
  // The whole point of deriving these: the baseline script's pacing used to be
  // a hand-picked 250ms measured against REQUESTS per second, while Google's
  // ceiling is denominated in ELEMENTS per minute. At 27 elements a call that
  // nominal cadence is 6,480 elements/min — more than twice the limit — and it
  // only ever stayed under because response latency padded the interval.
  // AMENITY_ROUTE_ELEMENTS_PER_CALL equals dataset-backed buckets times route candidates, excluding walkability buckets.
  it("counts elements per call from the dataset-backed buckets, not requests", () => {
    const routedBuckets = Object.values(AMENITY_TIERS)
      .filter((tier) => tier.dataset)
      .flatMap((tier) => tier.buckets);

    expect(AMENITY_ROUTE_ELEMENTS_PER_CALL).toBe(
      routedBuckets.length * AMENITY_ROUTE_CANDIDATES
    );
    // Walkability has no `dataset` and is never route-corrected, so it must
    // not inflate the element count and slow every run down for nothing.
    expect(routedBuckets).not.toContain("grocery");
  });

  // The baseline route pacing keeps elements per minute under Google's ceiling, within the configured utilisation fraction.
  it("paces the baseline run strictly under the element ceiling", () => {
    const callsPerMinute = 60_000 / AMENITY_BASELINE_ROUTE_PACING_MS;
    const elementsPerMinute = callsPerMinute * AMENITY_ROUTE_ELEMENTS_PER_CALL;

    expect(elementsPerMinute).toBeLessThan(GOOGLE_ROUTES_ELEMENTS_PER_MINUTE);
    // And with real headroom, not by a rounding hair — pacing controls when a
    // call STARTS, not when Google counts it, so jitter and retries land on
    // top of the nominal rate.
    expect(elementsPerMinute).toBeLessThanOrEqual(
      GOOGLE_ROUTES_ELEMENTS_PER_MINUTE * GOOGLE_ROUTES_QUOTA_UTILISATION
    );
    expect(GOOGLE_ROUTES_QUOTA_UTILISATION).toBeLessThan(1);
  });
});
