import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

// api/geocode and api/autocomplete are same-origin proxies for this app's own
// UI, not content meant to be indexed - everything else is a real page.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
