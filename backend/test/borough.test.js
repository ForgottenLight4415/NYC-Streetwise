import { describe, it, expect } from "vitest";
import { boroughFor } from "../src/lib/borough.js";

// Pure, no network, no Mongo — this is the whole point of deriving the borough
// from text the frontend already has rather than geocoding for it.

describe("boroughFor", () => {
  it("reads the locality out of a formatted address", () => {
    expect(boroughFor("88 Bedford Ave, Brooklyn, NY 11249", 40.7178, -73.9647)).toBe("Brooklyn");
    expect(boroughFor("980 Anderson Ave, Bronx, NY 10452", 40.8347, -73.9265)).toBe("Bronx");
    expect(boroughFor("142 Stuyvesant Pl, Staten Island, NY 10301", 40.6423, -74.0776)).toBe(
      "Staten Island"
    );
  });

  it("maps Google's 'New York' locality to Manhattan", () => {
    expect(boroughFor("456 Park Ave, New York, NY 10022", 40.7614, -73.9707)).toBe("Manhattan");
  });

  it("maps a Queens neighbourhood, which Google names instead of the borough", () => {
    expect(boroughFor("37-11 74th St, Jackson Heights, NY 11372", 40.7495, -73.8913)).toBe(
      "Queens"
    );
    expect(boroughFor("104-40 Queens Blvd, Forest Hills, NY 11375", 40.7218, -73.8448)).toBe(
      "Queens"
    );
  });

  it("falls back to the coordinate when the text names nothing known", () => {
    // An unlisted Queens neighbourhood — the envelope still gets it right.
    expect(boroughFor("1 Nowhere Ln, Utopia, NY 11365", 40.74, -73.79)).toBe("Queens");
  });

  it("prefers the address text over the envelope where the two disagree", () => {
    // The envelopes overlap along the Brooklyn/Queens line, so text has to win:
    // a rectangle cannot separate them, and the resident's own address can.
    expect(boroughFor("1 Grand Army Plaza, Brooklyn, NY 11238", 40.6743, -73.9704)).toBe(
      "Brooklyn"
    );
  });

  it("returns null rather than guessing when neither source is conclusive", () => {
    expect(boroughFor(null, 0, 0)).toBeNull();
    expect(boroughFor("somewhere", NaN, NaN)).toBeNull();
    expect(boroughFor(undefined, undefined, undefined)).toBeNull();
  });
});
