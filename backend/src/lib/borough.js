// Which borough a lookup belongs to.
//
// The backend does not geocode (see CLAUDE.md), so this does not ask Google for
// an address component — it reads what the frontend already displays. Google's
// formatted addresses name the borough as the locality for four of the five
// ("…, Brooklyn, NY 11249") and name Manhattan as "New York", so the text is
// enough almost every time; the bounding box only has to cover the rest.
//
// Derived HERE and nowhere else, same rule the complaint_type and status strings
// follow: one definition, imported by every caller.

/**
 * Rough borough envelopes. These OVERLAP — Queens and Brooklyn share a long
 * boundary, and no rectangle can separate them — so this is a fallback for
 * labelling a card, never a spatial join. Address text wins whenever it names a
 * borough, and `null` is an honest answer when neither source is conclusive.
 */
const BOROUGH_BOUNDS = [
  { name: "Manhattan", lat: [40.7, 40.88], lng: [-74.02, -73.91] },
  { name: "Brooklyn", lat: [40.57, 40.74], lng: [-74.05, -73.83] },
  { name: "Queens", lat: [40.54, 40.8], lng: [-73.96, -73.7] },
  { name: "Bronx", lat: [40.79, 40.92], lng: [-73.93, -73.76] },
  { name: "Staten Island", lat: [40.49, 40.65], lng: [-74.26, -74.05] },
];

/**
 * Localities as they appear in a formatted address, mapped to the borough they
 * mean. "New York" is Manhattan; the neighbourhood names are the ones Google
 * returns as the locality for Queens addresses, where it names the neighbourhood
 * rather than the borough ("37-11 74th St, Jackson Heights, NY 11372").
 */
const LOCALITY_TO_BOROUGH = new Map(
  Object.entries({
    "new york": "Manhattan",
    manhattan: "Manhattan",
    brooklyn: "Brooklyn",
    queens: "Queens",
    bronx: "Bronx",
    "the bronx": "Bronx",
    "staten island": "Staten Island",
    // Queens neighbourhoods Google uses in place of the borough. Not
    // exhaustive by design — an unlisted one falls through to the bounding box,
    // which gets Queens right for most of the borough's interior.
    astoria: "Queens",
    "long island city": "Queens",
    flushing: "Queens",
    "jackson heights": "Queens",
    "forest hills": "Queens",
    "jamaica": "Queens",
    "rego park": "Queens",
    sunnyside: "Queens",
    woodside: "Queens",
    ridgewood: "Queens",
    elmhurst: "Queens",
    corona: "Queens",
    bayside: "Queens",
    "far rockaway": "Queens",
    "rockaway park": "Queens",
    "kew gardens": "Queens",
    maspeth: "Queens",
    whitestone: "Queens",
    "college point": "Queens",
    "ozone park": "Queens",
    "richmond hill": "Queens",
    "middle village": "Queens",
    "fresh meadows": "Queens",
    "south richmond hill": "Queens",
    "st albans": "Queens",
    "saint albans": "Queens",
    "springfield gardens": "Queens",
    "howard beach": "Queens",
    "glen oaks": "Queens",
    "little neck": "Queens",
    "douglaston": "Queens",
    "briarwood": "Queens",
    "hollis": "Queens",
    "queens village": "Queens",
    "cambria heights": "Queens",
    "rosedale": "Queens",
    "arverne": "Queens",
    "breezy point": "Queens",
    "belle harbor": "Queens",
    "neponsit": "Queens",
    "east elmhurst": "Queens",
    "jamaica estates": "Queens",
    "bellerose": "Queens",
    "floral park": "Queens",
    "oakland gardens": "Queens",
  })
);

/**
 * Pulls the locality out of a formatted address.
 *
 * Google's shape is "<street>, <locality>, <state> <zip>[, <country>]", so the
 * locality is the second comma-separated part. Anything else returns null and
 * lets the coordinate decide.
 */
function localityOf(address) {
  if (typeof address !== "string") return null;
  const parts = address.split(",").map((part) => part.trim());
  if (parts.length < 2) return null;
  // Skip a trailing "USA" so a 4-part address still finds its locality at [1].
  const locality = parts[1];
  if (!locality) return null;
  // Strip a state/zip that ended up here (a 2-part address like "Queens, NY").
  const cleaned = locality.replace(/\s+(?:NY|New York)\s*\d*$/i, "").trim();
  return (cleaned || locality).toLowerCase();
}

/** The borough containing a point, or null when no envelope claims it. */
function boroughFromCoords(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const match = BOROUGH_BOUNDS.find(
    (b) => lat >= b.lat[0] && lat <= b.lat[1] && lng >= b.lng[0] && lng <= b.lng[1]
  );
  return match?.name ?? null;
}

/**
 * The borough for one lookup: the address text first, the coordinate second.
 *
 * Text wins because it is what the city and the resident call the place, and
 * because the envelopes overlap. Returns null rather than guessing when neither
 * source is conclusive — callers render nothing for a null.
 *
 * @param {string|null|undefined} address formatted address as displayed
 * @param {number} lat
 * @param {number} lng
 * @returns {string|null}
 */
export function boroughFor(address, lat, lng) {
  const locality = localityOf(address);
  if (locality && LOCALITY_TO_BOROUGH.has(locality)) {
    return LOCALITY_TO_BOROUGH.get(locality);
  }
  return boroughFromCoords(lat, lng);
}
