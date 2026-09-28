import { describe, it, expect } from "vitest";
import { haversineMeters, densifyLine, multiPolygonCentroid } from "../src/lib/geo.js";

// Pure functions, no fixtures needed beyond hand-computed NYC coordinates.

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters(40.7484, -73.9857, 40.7484, -73.9857)).toBe(0);
  });

  it("matches the known ~111.32km-per-degree-of-latitude constant", () => {
    // Empire State Building to a point exactly 0.01 degrees north.
    const d = haversineMeters(40.7484, -73.9857, 40.7584, -73.9857);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  it("matches a real measured NYC pair (Union Sq to Times Sq subway entrances)", () => {
    // 14 St-Union Sq (40.735736, -73.990568) to Times Sq-42 St
    // (40.755477, -73.986754) — straight-line distance is ~2.23km per
    // independent mapping tools.
    const d = haversineMeters(40.735736, -73.990568, 40.755477, -73.986754);
    expect(d).toBeGreaterThan(2150);
    expect(d).toBeLessThan(2300);
  });

  it("is symmetric", () => {
    const a = haversineMeters(40.7, -74.0, 40.75, -73.95);
    const b = haversineMeters(40.75, -73.95, 40.7, -74.0);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("densifyLine", () => {
  it("returns the input for 0 or 1 points", () => {
    expect(densifyLine([], 25)).toEqual([]);
    expect(densifyLine([[-73.99, 40.75]], 25)).toEqual([[-73.99, 40.75]]);
  });

  it("always includes the first and last vertex", () => {
    const line = [
      [-73.99, 40.75],
      [-73.98, 40.76],
      [-73.97, 40.77],
    ];
    const out = densifyLine(line, 25);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it("spaces consecutive points at most `spacingMeters` apart", () => {
    // A ~2.2km line (roughly Union Sq to Times Sq), densified at 25m spacing.
    const line = [
      [-73.990568, 40.735736],
      [-73.986754, 40.755477],
    ];
    const spacing = 25;
    const out = densifyLine(line, spacing);
    expect(out.length).toBeGreaterThan(50); // ~2.2km / 25m ~= 88 points

    for (let i = 1; i < out.length; i++) {
      const [lngA, latA] = out[i - 1];
      const [lngB, latB] = out[i];
      const d = haversineMeters(latA, lngA, latB, lngB);
      // Allow slight slack over the nominal spacing: the final segment can be
      // shorter, but no segment should be dramatically longer.
      expect(d).toBeLessThanOrEqual(spacing + 1);
    }
  });

  it("collapses zero-length segments without producing NaN points", () => {
    const line = [
      [-73.99, 40.75],
      [-73.99, 40.75], // duplicate vertex
      [-73.98, 40.76],
    ];
    const out = densifyLine(line, 25);
    for (const [lng, lat] of out) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });
});

describe("multiPolygonCentroid", () => {
  it("returns the geometric center of a simple square", () => {
    // A 1x1 degree square from (0,0) to (1,1), GeoJSON [lng, lat] order,
    // closed ring (first === last).
    const square = [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    ];
    const centroid = multiPolygonCentroid(square);
    expect(centroid.lng).toBeCloseTo(0.5, 6);
    expect(centroid.lat).toBeCloseTo(0.5, 6);
  });

  it("picks the largest ring across multiple polygons", () => {
    const tiny = [
      [10, 10],
      [10.001, 10],
      [10.001, 10.001],
      [10, 10.001],
      [10, 10],
    ];
    const big = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    const centroid = multiPolygonCentroid([[tiny], [big]]);
    expect(centroid.lng).toBeCloseTo(1, 6);
    expect(centroid.lat).toBeCloseTo(1, 6);
  });

  it("returns null when given no usable rings", () => {
    expect(multiPolygonCentroid([])).toBeNull();
  });
});
