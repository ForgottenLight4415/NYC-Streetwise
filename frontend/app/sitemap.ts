import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

// /report and /compare are excluded on purpose: both only render real content
// given an ?address=/&placeId= (or ?a=&b=) query string, which Next strips
// from a sitemap <loc>, so the bare route has nothing canonical to index -
// same reasoning as disallowing /api/ in robots.ts.
const LEGAL_LAST_MODIFIED = new Date("2026-09-10");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: LEGAL_LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: LEGAL_LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/cookies`,
      lastModified: LEGAL_LAST_MODIFIED,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
