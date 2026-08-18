import {
  NYC_BOUNDS,
  RADIUS_TIERS,
  STATUS_BUCKET_NAMES,
  ALL_COMPLAINT_TYPES,
} from "../config/constants.js";

/**
 * Thrown for bad client input. Routes translate this into a 400 rather than
 * each one re-implementing the same checks.
 */
export class BadRequestError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "BadRequestError";
    this.status = 400;
    this.details = details;
  }
}

function toFiniteNumber(value, field) {
  // Reject "" and null early: Number("") === 0, which would silently pass as
  // a valid coordinate on the equator.
  if (value === undefined || value === null || value === "") {
    throw new BadRequestError(`missing_${field}`, `${field} is required`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new BadRequestError(`invalid_${field}`, `${field} must be a number`);
  }
  return n;
}

/**
 * Validates a {lat, lng} pair (numbers or numeric strings) and asserts it falls
 * inside the NYC bounding box. Returns the parsed numbers.
 */
export function validateCoords({ lat, lng }) {
  const parsedLat = toFiniteNumber(lat, "lat");
  const parsedLng = toFiniteNumber(lng, "lng");

  const { minLat, maxLat, minLng, maxLng } = NYC_BOUNDS;
  if (
    parsedLat < minLat ||
    parsedLat > maxLat ||
    parsedLng < minLng ||
    parsedLng > maxLng
  ) {
    throw new BadRequestError(
      "out_of_bounds",
      `coordinate must be within NYC (lat ${minLat}-${maxLat}, lng ${minLng} to ${maxLng})`
    );
  }

  return { lat: parsedLat, lng: parsedLng };
}

/** Trend window in months, restricted to the offered set. */
export function validateMonths(value, { options, fallback }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = toFiniteNumber(value, "months");
  if (!options.includes(n)) {
    throw new BadRequestError(
      "invalid_months",
      `months must be one of: ${options.join(", ")}`
    );
  }
  return n;
}

/** Optional radius tier for /api/complaints; undefined means "both tiers". */
export function validateOptionalTier(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return validateTier(value);
}

/** Required radius tier for /api/explanation. */
export function validateTier(value) {
  const tiers = Object.keys(RADIUS_TIERS);
  if (value === undefined || value === null || value === "") {
    throw new BadRequestError("missing_tier", `tier is required (${tiers.join(" or ")})`);
  }
  if (!tiers.includes(value)) {
    throw new BadRequestError("invalid_tier", `tier must be one of: ${tiers.join(", ")}`);
  }
  return value;
}

/** Optional positive integer row cap, bounded so one request cannot pull the dataset. */
export function validateLimit(value, { fallback, max }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = toFiniteNumber(value, "limit");
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new BadRequestError(
      "invalid_limit",
      `limit must be a whole number between 1 and ${max}`
    );
  }
  return n;
}

/**
 * Optional zero-based page offset.
 *
 * Deliberately not validateLimit(): that rejects 0, and 0 is the first page.
 */
export function validateOffset(value, { max }) {
  if (value === undefined || value === null || value === "") return 0;
  const n = toFiniteNumber(value, "offset");
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new BadRequestError(
      "invalid_offset",
      `offset must be a whole number between 0 and ${max}`
    );
  }
  return n;
}

/**
 * Optional complaint bucket, scoped to a tier's own buckets.
 *
 * Requires `tier`, because "noise" is a block bucket and means nothing for a
 * building panel — accepting it unscoped would silently return zero rows and
 * read as "no complaints" rather than as a bad request.
 */
export function validateBucket(value, tier) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!tier) {
    throw new BadRequestError("missing_tier", "tier is required when filtering by bucket");
  }
  const buckets = Object.keys(RADIUS_TIERS[tier].buckets);
  if (!buckets.includes(value)) {
    throw new BadRequestError(
      "invalid_bucket",
      `bucket must be one of: ${buckets.join(", ")} (for tier ${tier})`
    );
  }
  return value;
}

/** Optional status bucket. Takes the bucket name, never a raw Socrata status. */
export function validateStatus(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!STATUS_BUCKET_NAMES.includes(value)) {
    throw new BadRequestError(
      "invalid_status",
      `status must be one of: ${STATUS_BUCKET_NAMES.join(", ")}`
    );
  }
  return value;
}

/** A single calendar day, "YYYY-MM-DD", for the group drill-in. */
export function validateDay(value) {
  if (value === undefined || value === null || value === "") {
    throw new BadRequestError("missing_day", "day is required (YYYY-MM-DD)");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestError("invalid_day", "day must be formatted YYYY-MM-DD");
  }
  // Rejects 2026-13-01 and 2026-02-30, which the regex alone lets through.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestError("invalid_day", "day must be a real calendar date");
  }
  return value;
}

/**
 * A complaint_type string for the drill-in, checked against the known set.
 *
 * Whitelisted rather than escaped-and-passed-through: this value reaches a SoQL
 * `where` clause, and the set of legal types is small, closed and already
 * defined in constants.js.
 */
export function validateComplaintType(value) {
  if (value === undefined || value === null || value === "") {
    throw new BadRequestError("missing_type", "type is required");
  }
  if (!ALL_COMPLAINT_TYPES.includes(value)) {
    throw new BadRequestError("invalid_type", "type is not a recognised complaint type");
  }
  return value;
}

/** Optional positive radius in meters, capped to keep Socrata queries sane. */
export function validateRadius(value, { fallback, max = 2000 }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = toFiniteNumber(value, "radius");
  if (n <= 0 || n > max) {
    throw new BadRequestError(
      "invalid_radius",
      `radius must be between 1 and ${max} meters`
    );
  }
  return n;
}
