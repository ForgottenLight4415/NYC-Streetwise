import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, Inter } from "next/font/google";
import { Header } from "@/components/Header";
import { API_BASE_URL } from "@/lib/api";
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
  title: "Streetwise NYC: Building Health & Block Quality Scores",
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
        {/* The Express backend is a different origin, and the first call to it
            is on the critical path of every page: the report's score, and the
            homepage's own hero card. This gets the DNS lookup and TLS handshake
            out of the way while the document is still parsing.

            The Maps SDK is NOT loaded here any more — it moved to the two
            routes that actually build a map. See app/report/page.tsx. */}
        <link rel="preconnect" href={API_BASE_URL} crossOrigin="" />
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
