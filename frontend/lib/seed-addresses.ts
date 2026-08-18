// A small set of real NYC addresses with real coordinates.
//
// This file used to be `mock-data.ts`, and most of it was a seeded PRNG that
// invented scores, bands and complaint counts for the homepage's "sample
// reports". That is gone: the homepage now shows only addresses the backend has
// actually scored from 311 data (GET /api/showcase), and shows nothing when it
// has none. Inventing a score for a product whose claim is "we only report what
// the city recorded" was the one thing the landing page must not do.
//
// What survives is the part that was always real — the addresses and their
// coordinates — and the one consumer that still needs them: the autocomplete
// route's fallback for when no Google Places key is configured, so the search
// box is usable offline. The backend keeps its own copy of the subset it
// pre-warms, in src/config/showcase.js; these two lists are independent by
// design, since one drives a search box and the other drives Socrata calls.

export interface SeedAddress {
  id: string;
  description: string;
  lat: number;
  lng: number;
  borough: string;
}

export const SEED_ADDRESSES: SeedAddress[] = [
  { id: "1", description: "123 Ludlow St, New York, NY 10002", lat: 40.7202, lng: -73.9877, borough: "Manhattan" },
  { id: "2", description: "456 Park Ave, New York, NY 10022", lat: 40.7614, lng: -73.9707, borough: "Manhattan" },
  { id: "3", description: "88 Bedford Ave, Brooklyn, NY 11249", lat: 40.7178, lng: -73.9647, borough: "Brooklyn" },
  { id: "4", description: "215 W 92nd St, New York, NY 10025", lat: 40.7911, lng: -73.9724, borough: "Manhattan" },
  { id: "5", description: "37-11 74th St, Jackson Heights, NY 11372", lat: 40.7495, lng: -73.8913, borough: "Queens" },
  { id: "6", description: "1 Grand Army Plaza, Brooklyn, NY 11238", lat: 40.6743, lng: -73.9704, borough: "Brooklyn" },
  { id: "7", description: "980 Anderson Ave, Bronx, NY 10452", lat: 40.8347, lng: -73.9265, borough: "Bronx" },
  { id: "8", description: "142 Stuyvesant Pl, Staten Island, NY 10301", lat: 40.6423, lng: -74.0776, borough: "Staten Island" },
  { id: "9", description: "350 W 42nd St, New York, NY 10036", lat: 40.7584, lng: -73.9929, borough: "Manhattan" },
  { id: "10", description: "27 Greenpoint Ave, Brooklyn, NY 11222", lat: 40.7304, lng: -73.9573, borough: "Brooklyn" },
  { id: "11", description: "104-40 Queens Blvd, Forest Hills, NY 11375", lat: 40.7218, lng: -73.8448, borough: "Queens" },
  { id: "12", description: "2201 Grand Concourse, Bronx, NY 10457", lat: 40.8465, lng: -73.9032, borough: "Bronx" },
  { id: "13", description: "225 E 6th St, New York, NY 10003", lat: 40.7266, lng: -73.9868, borough: "Manhattan" },
  { id: "14", description: "412 Vanderbilt Ave, Brooklyn, NY 11238", lat: 40.6825, lng: -73.9688, borough: "Brooklyn" },
  { id: "15", description: "63-05 108th St, Forest Hills, NY 11375", lat: 40.7233, lng: -73.8462, borough: "Queens" },
];

/** The offline stand-in for Google Places autocomplete. Substring match, no ranking. */
export function findSuggestions(query: string, limit = 6): SeedAddress[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SEED_ADDRESSES.filter((a) => a.description.toLowerCase().includes(q)).slice(0, limit);
}
