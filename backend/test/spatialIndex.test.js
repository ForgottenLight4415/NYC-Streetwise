import { describe, it, expect } from "vitest";
import { buildIndex } from "../src/providers/amenities/spatialIndex.js";
import { haversineMeters } from "../src/lib/geo.js";
import { NYC_BOUNDS } from "../src/config/constants.js";

function seededRandom(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNycPoint(rand) {
  const lat = NYC_BOUNDS.minLat + rand() * (NYC_BOUNDS.maxLat - NYC_BOUNDS.minLat);
  const lng = NYC_BOUNDS.minLng + rand() * (NYC_BOUNDS.maxLng - NYC_BOUNDS.minLng);
  return [lat, lng];
}

function bruteNearest(points, lat, lng, maxMeters, names) {
  let best = null;
  let bestDist = Infinity;
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const d = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
    if (d < bestDist) {
      bestDist = d;
      const nameIdx = points[i * 3 + 2];
      best = { meters: d, name: nameIdx >= 0 ? names[nameIdx] : null };
    }
  }
  if (best === null || best.meters > maxMeters) return null;
  return best;
}

function bruteNearestN(points, lat, lng, count, maxMeters, names) {
  const n = points.length / 3;
  const all = [];
  for (let i = 0; i < n; i++) {
    const meters = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
    if (meters > maxMeters) continue;
    const nameIdx = points[i * 3 + 2];
    all.push({ meters, name: nameIdx >= 0 ? names[nameIdx] : null });
  }
  all.sort((a, b) => a.meters - b.meters);
  return all.slice(0, count);
}

function bruteCountWithin(points, lat, lng, radiusMeters) {
  let count = 0;
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    if (haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]) <= radiusMeters) count++;
  }
  return count;
}

function bruteAllWithin(points, lat, lng, radiusMeters, names, limit = Infinity) {
  const n = points.length / 3;
  const all = [];
  for (let i = 0; i < n; i++) {
    const meters = haversineMeters(lat, lng, points[i * 3], points[i * 3 + 1]);
    if (meters > radiusMeters) continue;
    const nameIdx = points[i * 3 + 2];
    all.push({ meters, name: nameIdx >= 0 ? names[nameIdx] : null });
  }
  all.sort((a, b) => a.meters - b.meters);
  return all.slice(0, limit);
}

function buildRandomDataset(rand, count) {
  const points = [];
  const names = [];
  for (let i = 0; i < count; i++) {
    const [lat, lng] = randomNycPoint(rand);
    points.push(lat, lng, i);
    names.push(`point-${i}`);
  }
  return { points, names };
}

describe("buildIndex.nearest", () => {
  it("matches a brute-force scan over 1,000 random NYC points", () => {
    const rand = seededRandom(20260829);
    const { points, names } = buildRandomDataset(rand, 1000);
    const index = buildIndex(points, names);

    for (let q = 0; q < 200; q++) {
      const [lat, lng] = randomNycPoint(rand);
      const maxMeters = 2000;
      const expected = bruteNearest(points, lat, lng, maxMeters, names);
      const actual = index.nearest(lat, lng, maxMeters);

      if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).not.toBeNull();
        expect(actual.meters).toBeCloseTo(expected.meters, 6);
        expect(actual.name).toBe(expected.name);
      }
    }
  });

  it("returns null on an empty index", () => {
    const index = buildIndex([], []);
    expect(index.nearest(40.75, -73.98, 2000)).toBeNull();
  });

  it("returns null when the nearest point is past maxMeters", () => {
    const points = [40.75, -73.98, 0];
    const names = ["only-point"];
    const index = buildIndex(points, names);
    // ~1.1km away (0.01 degrees of latitude)
    const far = index.nearest(40.76, -73.98, 500);
    expect(far).toBeNull();
    const near = index.nearest(40.76, -73.98, 2000);
    expect(near).not.toBeNull();
  });

  it("finds a point in an adjacent grid cell, not just the query's own cell", () => {
    // Two points 400m apart, straddling a grid boundary — a naive same-cell-
    // only search would miss the second one.
    const points = [40.75, -73.98, 0, 40.7536, -73.98, 1];
    const names = ["near", "far"];
    const index = buildIndex(points, names);
    const result = index.nearest(40.75, -73.98, 2000);
    expect(result.name).toBe("near");
    expect(result.meters).toBeCloseTo(0, 3);
  });
});

describe("buildIndex.nearestN", () => {
  it("matches a brute-force top-N scan over 1,000 random NYC points", () => {
    const rand = seededRandom(90210);
    const { points, names } = buildRandomDataset(rand, 1000);
    const index = buildIndex(points, names);

    for (let q = 0; q < 200; q++) {
      const [lat, lng] = randomNycPoint(rand);
      const maxMeters = 2000;
      const expected = bruteNearestN(points, lat, lng, 3, maxMeters, names);
      const actual = index.nearestN(lat, lng, 3, maxMeters);

      expect(actual.length).toBe(expected.length);
      actual.forEach((candidate, i) => {
        expect(candidate.meters).toBeCloseTo(expected[i].meters, 6);
        expect(candidate.name).toBe(expected[i].name);
      });
    }
  });

  it("includes each candidate's own coordinates, unlike nearest()", () => {
    const points = [40.75, -73.98, 0];
    const names = ["only-point"];
    const index = buildIndex(points, names);
    const [result] = index.nearestN(40.75, -73.98, 3, 2000);
    expect(result.lat).toBeCloseTo(40.75, 6);
    expect(result.lng).toBeCloseTo(-73.98, 6);
  });

  it("nearest() is exactly nearestN(..., 1, ...)'s first result", () => {
    const rand = seededRandom(777);
    const { points, names } = buildRandomDataset(rand, 300);
    const index = buildIndex(points, names);
    const [lat, lng] = randomNycPoint(rand);

    const single = index.nearest(lat, lng, 2000);
    const [first] = index.nearestN(lat, lng, 1, 2000);
    expect(single.meters).toBeCloseTo(first.meters, 6);
    expect(single.name).toBe(first.name);
  });

  it("returns fewer than N when the dataset has fewer than N points in range", () => {
    const points = [40.75, -73.98, 0, 40.7502, -73.98, 1];
    const names = ["a", "b"];
    const index = buildIndex(points, names);
    expect(index.nearestN(40.75, -73.98, 5, 2000).length).toBe(2);
  });

  it("returns [] on an empty index or a non-positive count", () => {
    const index = buildIndex([], []);
    expect(index.nearestN(40.75, -73.98, 3, 2000)).toEqual([]);

    const nonEmpty = buildIndex([40.75, -73.98, 0], ["a"]);
    expect(nonEmpty.nearestN(40.75, -73.98, 0, 2000)).toEqual([]);
  });
});

describe("buildIndex.countWithin", () => {
  it("matches a brute-force scan", () => {
    const rand = seededRandom(4242);
    const { points, names } = buildRandomDataset(rand, 500);
    const index = buildIndex(points, names);

    for (let q = 0; q < 50; q++) {
      const [lat, lng] = randomNycPoint(rand);
      const radius = 800;
      expect(index.countWithin(lat, lng, radius)).toBe(
        bruteCountWithin(points, lat, lng, radius)
      );
    }
  });

  it("is inclusive at the exact boundary", () => {
    const points = [40.75, -73.98, 0];
    const names = ["p"];
    const index = buildIndex(points, names);
    const exactDistance = haversineMeters(40.75, -73.98, 40.751, -73.98);
    expect(index.countWithin(40.751, -73.98, exactDistance)).toBe(1);
    expect(index.countWithin(40.751, -73.98, exactDistance - 1)).toBe(0);
  });

  it("returns 0 for an empty index", () => {
    const index = buildIndex([], []);
    expect(index.countWithin(40.75, -73.98, 800)).toBe(0);
  });
});

describe("buildIndex.allWithin", () => {
  it("matches a brute-force scan, sorted ascending by distance", () => {
    const rand = seededRandom(13579);
    const { points, names } = buildRandomDataset(rand, 500);
    const index = buildIndex(points, names);

    for (let q = 0; q < 50; q++) {
      const [lat, lng] = randomNycPoint(rand);
      const radius = 800;
      const expected = bruteAllWithin(points, lat, lng, radius, names);
      const actual = index.allWithin(lat, lng, radius, { limit: 10000 });

      expect(actual.length).toBe(expected.length);
      actual.forEach((candidate, i) => {
        expect(candidate.meters).toBeCloseTo(expected[i].meters, 6);
        expect(candidate.name).toBe(expected[i].name);
      });
    }
  });

  it("count matches countWithin exactly (same underlying set, no limit)", () => {
    const rand = seededRandom(24680);
    const { points, names } = buildRandomDataset(rand, 500);
    const index = buildIndex(points, names);

    for (let q = 0; q < 50; q++) {
      const [lat, lng] = randomNycPoint(rand);
      const radius = 800;
      expect(index.allWithin(lat, lng, radius, { limit: 10000 }).length).toBe(
        index.countWithin(lat, lng, radius)
      );
    }
  });

  it("includes each match's own coordinates, same shape as nearestN", () => {
    const points = [40.75, -73.98, 0];
    const names = ["only-point"];
    const index = buildIndex(points, names);
    const [result] = index.allWithin(40.75, -73.98, 800);
    expect(result.lat).toBeCloseTo(40.75, 6);
    expect(result.lng).toBeCloseTo(-73.98, 6);
  });

  it("defaults limit to 50 and caps the returned array there", () => {
    const points = [];
    const names = [];
    // 60 points all within a few metres of the query, well inside 800m.
    for (let i = 0; i < 60; i++) {
      points.push(40.75, -73.98 + i * 0.00001, i);
      names.push(`p${i}`);
    }
    const index = buildIndex(points, names);
    const result = index.allWithin(40.75, -73.98, 800);
    expect(result.length).toBe(50);
    expect(index.countWithin(40.75, -73.98, 800)).toBe(60);
  });

  it("respects an explicit limit smaller than the match count", () => {
    const points = [40.75, -73.98, 0, 40.7502, -73.98, 1, 40.7505, -73.98, 2];
    const names = ["a", "b", "c"];
    const index = buildIndex(points, names);
    const result = index.allWithin(40.75, -73.98, 2000, { limit: 2 });
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
  });

  it("returns [] for an empty index", () => {
    const index = buildIndex([], []);
    expect(index.allWithin(40.75, -73.98, 800)).toEqual([]);
  });

  it("carries routes when the index was built with routeSets/routeIdx", () => {
    const points = [40.75, -73.98, -1, 40.7501, -73.98, -1];
    const names = [];
    const routeSets = [["4", "5", "6"]];
    const routeIdx = [0, -1];
    const index = buildIndex(points, names, { routeSets, routeIdx });
    const result = index.allWithin(40.75, -73.98, 800);
    expect(result.find((r) => r.meters < 1).routes).toEqual(["4", "5", "6"]);
    expect(result.find((r) => r.meters > 1).routes).toEqual([]);
  });

  it("omits routes entirely when the index has no route data", () => {
    const points = [40.75, -73.98, -1];
    const index = buildIndex(points, []);
    const [result] = index.allWithin(40.75, -73.98, 800);
    expect(result).not.toHaveProperty("routes");
  });
});
