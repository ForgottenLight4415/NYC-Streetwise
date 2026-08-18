// The curated showcase set: real NYC addresses with real coordinates.
//
// Why this file exists. The homepage shows cached scores, and a cache is empty
// on a fresh deploy and thins out after the 24h TTL. Without a committed set the
// page would have nothing real to show until someone happened to run a report —
// and the alternative it replaced was fabricated scores, which is the whole
// problem being fixed.
//
// COORDINATES ARE PART OF THE DATA, not a convenience. The backend does not
// geocode, so a warm run has no way to turn "456 Park Ave" into a point. These
// were carried over from the frontend's seed list, where they were already real;
// only the score generator wrapped around them was invented.
//
// Every entry is scored from live 311 data like any other address. Nothing here
// biases a score — the list decides which addresses are pre-warmed, never what
// their numbers say.
//
// Eight, spread across all five boroughs, so the carousel fills without the
// warm run costing more than a handful of Socrata calls (two per address).
// No entry is special: the hero card's fallback subject is drawn from the list
// at random (randomShowcaseAddress below), so any of them can be the first thing
// a visitor sees on a cold homepage.

/** @type {ReadonlyArray<{address: string, lat: number, lng: number}>} */
export const SHOWCASE_ADDRESSES = Object.freeze([
  { address: "456 Park Ave, New York, NY 10022", lat: 40.7614, lng: -73.9707 },
  { address: "123 Ludlow St, New York, NY 10002", lat: 40.7202, lng: -73.9877 },
  { address: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647 },
  { address: "1 Grand Army Plaza, Brooklyn, NY 11238", lat: 40.6743, lng: -73.9704 },
  { address: "37-11 74th St, Jackson Heights, NY 11372", lat: 40.7495, lng: -73.8913 },
  { address: "104-40 Queens Blvd, Forest Hills, NY 11375", lat: 40.7218, lng: -73.8448 },
  { address: "980 Anderson Ave, Bronx, NY 10452", lat: 40.8347, lng: -73.9265 },
  { address: "142 Stuyvesant Pl, Staten Island, NY 10301", lat: 40.6423, lng: -74.0776 },
]);

/**
 * One curated address at random, for a caller that needs a subject and found
 * nothing cached — the homepage's hero card, when the whole showcase is empty.
 *
 * Drawn from the list rather than pinned to an index on purpose. The frontend
 * used to hardcode 456 Park Ave for this, which meant the same building was
 * both the fixed face of a cold homepage and a duplicate of a committed list it
 * could silently drift from. Any of the eight is equally real and equally
 * pre-warmed, so there is no reason to privilege one.
 */
export function randomShowcaseAddress() {
  return SHOWCASE_ADDRESSES[Math.floor(Math.random() * SHOWCASE_ADDRESSES.length)];
}
