import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Header } from "@/components/Header";
import { mapsScriptSrc } from "@/lib/maps-keys";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Streetwise — Check a landlord and block before you sign",
  description:
    "Search any NYC address for a Building Health Score and Block Quality Score built from public 311 complaint data.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Rendered into page source, so this is the referrer-restricted CLIENT key
  // (GOOGLE_MAPS_CLIENT_KEY) — never the billed server key. See lib/maps-keys.ts.
  const scriptSrc = mapsScriptSrc();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>{scriptSrc && <script async src={scriptSrc} />}</head>
      <body className="min-h-full flex flex-col bg-[color:var(--background)] text-[color:var(--foreground)]">
        <Header />
        {children}
      </body>
    </html>
  );
}
