// Same trailing-slash-stripping pattern as API_BASE_URL in lib/api.ts, and the
// same localhost fallback shape — this one just points at this app's own
// origin instead of the backend's, for robots.ts/sitemap.ts to build absolute
// URLs from.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
).replace(/\/+$/, "");
