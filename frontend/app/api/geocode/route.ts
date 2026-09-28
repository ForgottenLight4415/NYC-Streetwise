import { NextRequest, NextResponse, after } from "next/server";
import { TtlCache } from "@/lib/lru";
import { serverMapsKey } from "@/lib/maps-keys";
import { recordLookup } from "@/lib/record-lookup";

export interface GeocodeResponse {
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
}

/**
 * Where a building stands does not change, so this is about as cacheable as a
 * lookup gets. Every report load goes through here, and the homepage's four
 * preset chips all resolve to the same four coordinates forever.
 *
 * Twelve hours rather than something longer only because a wrong or stale entry
 * should age out on its own rather than needing a deploy.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX = 5000;

const geocodeCache = new TtlCache<GeocodeResponse>(CACHE_MAX, CACHE_TTL_MS);

/**
 * CDN caching for the free-text path only.
 *
 * The placeId path deliberately does NOT get this. That branch is the one that
 * fires `recordLookup` (see below), and a response served from Vercel's edge
 * never invokes the function — so putting this header on it would quietly
 * starve the homepage's showcase feed of exactly the lookups it exists to
 * count. The in-process cache still spares the billed Google call there; this
 * header only adds the tier that would skip our own code.
 */
const CDN_CACHE_CONTROL =
  "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";

// Google Geocoding API — converts a free-text address (or a Places placeId)
// into coordinates for the map + score lookup.
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address");
  const placeId = request.nextUrl.searchParams.get("placeId");

  if (!address && !placeId) {
    return NextResponse.json(
      { error: "Either 'address' or 'placeId' parameter required" },
      { status: 400 }
    );
  }

  // Namespaced, because the same string could plausibly arrive as either kind
  // of input and they resolve through different Google APIs.
  const cacheKey = placeId
    ? `p:${placeId}`
    : `a:${address!.trim().toLowerCase().replace(/\s+/g, " ")}`;

  const cached = geocodeCache.get(cacheKey);
  if (cached) {
    // Recorded on a cache HIT too. This is a popularity signal, not a geocode:
    // skipping it here would mean the most-looked-up addresses — the ones that
    // stay warm in this cache — were the only ones never counted, which is
    // precisely backwards for a "recently checked" feed.
    if (placeId && cached.address) {
      const { address: canonical, lat, lng } = cached;
      after(() => recordLookup(canonical, lat, lng));
    }
    return NextResponse.json(cached, {
      headers: placeId ? undefined : { "Cache-Control": CDN_CACHE_CONTROL },
    });
  }

  // Server-side key only (Geocoding + Places). The browser's client key is a
  // different credential and is not accepted here — see lib/maps-keys.ts.
  const apiKey = serverMapsKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google Maps server key not configured. Set GOOGLE_MAPS_API_KEY in frontend/.env.local." },
      { status: 500 }
    );
  }

  try {
    if (placeId) {
      const detailsResponse = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
        {
          headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "location,displayName,formattedAddress",
          },
        }
      );

      if (!detailsResponse.ok) {
        return NextResponse.json(
          { error: "Failed to get place details" },
          { status: 500 }
        );
      }

      const placeDetails = await detailsResponse.json();
      const location = placeDetails.location;

      if (!location) {
        return NextResponse.json(
          { error: "Could not determine coordinates" },
          { status: 400 }
        );
      }

      const result: GeocodeResponse = {
        address: placeDetails.formattedAddress || placeDetails.displayName?.text || address || "",
        lat: location.latitude,
        lng: location.longitude,
        placeId,
      };

      // Recorded HERE, on the placeId path only, and never from the browser.
      //
      // A placeId means the user picked a real suggestion out of Places
      // autocomplete, and `formattedAddress` is Google's own canonical string
      // for it — so the address the homepage will display was never typed by
      // anyone. The free-text branch below deliberately records nothing: it
      // still produces a perfectly good report, it just cannot promise the same
      // provenance, and the homepage is the one place where that matters.
      //
      // after(), not a floating promise. Work started and left unawaited in a
      // route handler is not guaranteed to run: the response returns, the
      // invocation is torn down, and the request never leaves. That is exactly
      // what happened in the first cut of this — the write silently never
      // landed. after() is the supported way to say "do this once the response
      // is sent", so it keeps the geocode off this call's latency without
      // gambling on the runtime finishing it.
      if (placeDetails.formattedAddress) {
        const canonical = placeDetails.formattedAddress;
        after(() => recordLookup(canonical, location.latitude, location.longitude));
      }

      geocodeCache.set(cacheKey, result);
      return NextResponse.json(result);
    }

    const geocodingUrl = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    geocodingUrl.searchParams.set("address", address!);
    geocodingUrl.searchParams.set("components", "country:US");
    geocodingUrl.searchParams.set("key", apiKey);

    const geocodeResponse = await fetch(geocodingUrl.toString());
    if (!geocodeResponse.ok) {
      return NextResponse.json(
        { error: "Failed to geocode address" },
        { status: 500 }
      );
    }

    const geocodeData = await geocodeResponse.json();

    if (geocodeData.status === "REQUEST_DENIED") {
      return NextResponse.json(
        {
          error:
            "Google Maps geocoding is unavailable. Enable billing on the Google Cloud project and make sure the Geocoding API is enabled.",
        },
        { status: 402 }
      );
    }

    if (geocodeData.status !== "OK" || !geocodeData.results?.length) {
      return NextResponse.json({ error: "Address not found" }, { status: 404 });
    }

    const result = geocodeData.results[0];
    const response: GeocodeResponse = {
      address: result.formatted_address,
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      placeId: result.place_id,
    };
    geocodeCache.set(cacheKey, response);
    return NextResponse.json(response, {
      headers: { "Cache-Control": CDN_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("Geocode error:", error);
    return NextResponse.json({ error: "Failed to geocode address" }, { status: 500 });
  }
}
