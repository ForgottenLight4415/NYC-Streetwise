import { NextRequest, NextResponse } from "next/server";
import { serverMapsKey } from "@/lib/maps-keys";

export interface GeocodeResponse {
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
}

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
    return NextResponse.json(response);
  } catch (error) {
    console.error("Geocode error:", error);
    return NextResponse.json({ error: "Failed to geocode address" }, { status: 500 });
  }
}
