import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, Inter } from "next/font/google";
import { Header } from "@/components/Header";
import { mapsScriptSrc } from "@/lib/maps-keys";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

// Display: a signage grotesque. NYC wayfinding — subway, street blades, the
// 311 forms themselves — is set in neo-grotesques, so this is the subject's own
// lettering rather than a decorative pick. Used only at large sizes.
const archivo = Archivo({
  variable: "--font-display",
  subsets: ["latin"],
});

// Body: chosen for small-size legibility, because the report pages are dense
// lists of complaint labels and dates.
const inter = Inter({
  variable: "--font-body",
  subsets: ["latin"],
});

// Data: scores, counts, radii, dates, complaint IDs. These are record fields
// off a municipal dataset and are set as such.
const plexMono = IBM_Plex_Mono({
  variable: "--font-data",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Streetwise — Check a landlord and block before you sign",
  description:
    "Search any NYC address for a Building Health Score and Block Quality Score built from public 311 complaint data.",
};

export const viewport: Viewport = {
  // Matches --background in each theme so the browser chrome doesn't flash a
  // white bar above a dark page on mobile.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Rendered into page source, so this is the referrer-restricted CLIENT key
  // (GOOGLE_MAPS_CLIENT_KEY) — never the billed server key. See lib/maps-keys.ts.
  const scriptSrc = mapsScriptSrc();

  return (
    <html
      lang="en"
      // suppressHydrationWarning: the inline script below sets `data-theme`
      // before React hydrates, so the client's <html> attributes legitimately
      // differ from the server's. Scoped to this element only.
      suppressHydrationWarning
      className={`${archivo.variable} ${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {scriptSrc && <script async src={scriptSrc} />}
      </head>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <a
          href="#main"
          className="sr-only rounded-full px-4 py-2 text-sm font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-(--surface-1) focus:text-(--text-primary)"
          style={{ boxShadow: "var(--shadow-md)" }}
        >
          Skip to content
        </a>
        <Header />
        {children}
      </body>
    </html>
  );
}
