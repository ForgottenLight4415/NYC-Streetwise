import Image from "next/image";
import Link from "next/link";
import { AddressSearch } from "@/components/AddressSearch";
import { CitywideBaselinePanel } from "@/components/CitywideBaselinePanel";
import { FeaturedCarousel } from "@/components/FeaturedCarousel";
import { HeroSampleCard } from "@/components/HeroSampleCard";
import {
  ArrowRightIcon,
  BuildingIcon,
  BlockIcon,
  MapPinIcon,
} from "@/components/icons";
import { fetchShowcase } from "@/lib/api";

/**
 * Statically rendered, revalidated every five minutes.
 *
 * The showcase endpoint is cache-only on the backend - it never calls Socrata -
 * so this costs a few milliseconds, and ISR means no visitor ever waits on it at
 * all. Five minutes is short enough that an address someone looks up shows up on
 * the homepage while they are still in the session, and long enough that the
 * page is served from the static cache almost every time.
 */
export const revalidate = 300;

/**
 * How many addresses to ask for: one for the hero card, the rest for the
 * carousel, plus headroom so a couple of expired entries don't empty the row.
 */
const SHOWCASE_LIMIT = 12;

/** Below this the carousel reads as an accident rather than a selection. */
const MIN_CAROUSEL_ITEMS = 3;

/**
 * The chips under the search box, for when the cache has nothing to offer.
 *
 * Real addresses, but presets: they say "here is the shape of a query", which is
 * all a chip has ever claimed. They are also the addresses the backend pre-warms
 * (backend/src/config/showcase.js), so on a warm deploy the cached versions of
 * these are exactly what replaces them.
 */
const EXAMPLE_ADDRESSES = [
  "123 Ludlow St, New York, NY 10002",
  "456 Park Ave, New York, NY 10022",
  "88 Bedford Ave, Brooklyn, NY 11249",
  "37-11 74th St, Jackson Heights, NY 11372",
];

const CHIP_COUNT = 4;

/**
 * The hero rail. These are the real scoring parameters from the backend
 * (RADIUS_TIERS in config/constants.js), not marketing figures - for a product
 * whose whole claim is "we only report what the city recorded", the method is
 * the most trustworthy thing the page can lead with.
 */
const RADII = [
  {
    value: "25",
    unit: "m",
    label: "Building radius",
    body: "Complaints filed at the address itself: heat, hot water, plumbing.",
  },
  {
    value: "350",
    unit: "m",
    label: "Block radius",
    body: "The surrounding street: noise, illegal parking, street condition.",
  },
];

const FEATURES = [
  {
    icon: BuildingIcon,
    title: "Building Health Score",
    body: "Heat and hot water outages, unsanitary conditions, and plumbing failures tied to the specific address - the record nobody reads before signing a lease.",
    colorVar: "--series-building",
    inkVar: "--series-building-ink",
  },
  {
    icon: BlockIcon,
    title: "Block Quality Score",
    body: "Noise and illegal parking are the two highest-volume 311 categories citywide. See what the block is actually like before you move in.",
    colorVar: "--series-block",
    inkVar: "--series-block-ink",
  },
  {
    icon: MapPinIcon,
    title: "Grounded in public records",
    body: "Every score traces back to NYC 311 Service Requests - no reviews, no rumors, just the complaint history.",
    colorVar: "--status-good",
    inkVar: "--status-good-ink",
  },
];

const STEPS = [
  {
    title: "Enter an address",
    body: "Type any NYC address and we pull the 311 history filed around it.",
  },
  {
    title: "The building and the block",
    body: "One score covers the building itself; another covers the surrounding block.",
  },
  {
    title: "Decide with confidence",
    body: "Read the verdict, the complaint breakdown, and the trend before you tour.",
  },
];

export default async function Home() {
  // One call feeds all three address sections. Returns [] on any failure, and
  // fewer items than asked for whenever the 24h counts cache has thinned out -
  // every section below is written to render whatever it is handed.
  const { items, fallback } = await fetchShowcase("top", SHOWCASE_LIMIT, {
    next: { revalidate },
  });

  // The chips take the most-looked-up addresses and top up from the presets, so
  // there are always exactly four and they never shift under the cursor.
  const chips = [...items.map((item) => item.address), ...EXAMPLE_ADDRESSES]
    .filter((address, i, all) => all.indexOf(address) === i)
    .slice(0, CHIP_COUNT);

  // The hero card gets the most-looked-up address; the carousel gets the rest,
  // so the same report is never on screen twice. With nothing cached it gets the
  // backend's randomly-chosen curated address instead and scores it live -
  // no address is hardcoded here, and none is privileged over the others.
  const [heroItem, ...carouselItems] = items;

  // Below the threshold the carousel would be a one- or two-card loop repeating
  // itself, which reads as a bug. The citywide baseline panel takes the slot.
  const showCarousel = carouselItems.length >= MIN_CAROUSEL_ITEMS;

  return (
    <main id="main" className="flex-1">
      {/* ===================== Hero =====================
          `isolate` keeps the -z-10/-z-20 photo layers behind the hero content
          but in front of the page canvas; `z-10` lifts the section above the
          ones below it so the search dropdown is never painted under them.
          Deliberately not clipped - the sample card hangs past the bottom edge.
          `-mt-16 pt-16` slides the hero up under the transparent 4rem header. */}
      <section className="relative isolate z-10 -mt-16 pt-16">
        {/* next/image rather than a CSS background: the source file is ~6.5MB,
            and this serves a resized, modern-format version per breakpoint. */}
        <div className="absolute inset-0 -z-20 overflow-hidden">
          <Image
            src="/hero-nyc.jpg"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover object-center"
          />
        </div>
        <div
          className="absolute inset-0 -z-10"
          style={{ background: "var(--hero-scrim)" }}
        />

        <div className="on-photo mx-auto max-w-6xl px-4 pb-32 pt-12 sm:px-6 sm:pt-16 lg:pb-40 lg:pt-24">
          <div className="lg:grid lg:grid-cols-12 lg:gap-10">
            {/* ---------- content column ---------- */}
            <div className="lg:col-span-8">
              <p
                className="rise font-data text-center text-[11px] font-medium uppercase tracking-[0.18em] lg:text-left"
                style={{
                  color: "var(--on-photo-faint)",
                  ["--delay" as string]: "0ms",
                }}
              >
                NYC 311 Service Requests · 24-month window
              </p>

              <h1
                className="rise font-display mt-4 text-center text-[2.75rem] font-semibold leading-[0.98] tracking-[-0.035em] sm:text-6xl lg:text-left lg:text-7xl"
                style={{
                  color: "var(--on-photo)",
                  ["--delay" as string]: "80ms",
                }}
              >
                Every address
                <br />
                has a record.
              </h1>

              <p
                className="rise mx-auto mt-5 max-w-xl text-center text-base leading-relaxed sm:text-lg lg:mx-0 lg:text-left"
                style={{
                  color: "var(--on-photo-dim)",
                  ["--delay" as string]: "160ms",
                }}
              >
                Search any NYC address for a Building Health Score and a Block
                Quality Score - the landlord&rsquo;s complaint history and the
                block&rsquo;s, read straight off the city&rsquo;s own 311
                filings.
              </p>

              {/* relative z-20: the `rise` entrance animates opacity and
                  transform, and an element whose fill-mode keeps those applied
                  retains a stacking context - so the chips row below was
                  painting over the open suggestion panel. Ordering the search
                  above its later siblings fixes it at the source. */}
              <div
                className="rise relative z-20 mt-8 max-w-2xl lg:mt-10"
                style={{ ["--delay" as string]: "240ms" }}
              >
                <AddressSearch autoFocus />
              </div>

              <div
                className="rise mt-5 flex flex-wrap items-center justify-center gap-2 lg:justify-start"
                style={{ ["--delay" as string]: "320ms" }}
              >
                <span
                  className="hidden text-sm sm:inline"
                  style={{ color: "var(--on-photo-faint)" }}
                >
                  Try:
                </span>
                {chips.map((a) => (
                  <Link
                    key={a}
                    href={`/report?address=${encodeURIComponent(a)}`}
                    className="rounded-full border px-3 py-1.5 text-sm font-medium backdrop-blur transition-colors"
                    style={{
                      borderColor: "var(--photo-rule)",
                      background: "var(--photo-veil)",
                      color: "var(--on-photo)",
                    }}
                  >
                    {a.split(",")[0]}
                  </Link>
                ))}
              </div>
            </div>

            {/* ---------- right rail ----------
                On desktop this is the reference's stat column, split off by a
                hairline rule. On mobile the rule goes and the two radii sit
                side by side beneath the search, where they still read as the
                method rather than as decoration. */}
            <aside
              className="rise mt-12 lg:col-span-4 lg:mt-0 lg:border-l lg:pl-10"
              style={{
                borderColor: "var(--photo-rule)",
                ["--delay" as string]: "400ms",
              }}
            >
              <div className="flex h-full flex-col justify-between gap-10">
                <div className="flex flex-row gap-8 sm:gap-10 lg:flex-col lg:gap-9">
                  {RADII.map((r) => (
                    <div key={r.label} className="min-w-0 flex-1">
                      <p
                        className="font-data text-3xl font-semibold leading-none sm:text-4xl"
                        style={{ color: "var(--on-photo)" }}
                      >
                        {r.value}
                        <span className="text-xl sm:text-2xl">{r.unit}</span>
                      </p>
                      <p
                        className="mt-2 text-sm font-semibold"
                        style={{ color: "var(--on-photo)" }}
                      >
                        {r.label}
                      </p>
                      <p
                        className="mt-1 text-[13px] leading-snug"
                        style={{ color: "var(--on-photo-faint)" }}
                      >
                        {r.body}
                      </p>
                    </div>
                  ))}
                </div>

                <div>
                  <p
                    className="font-data text-[11px] uppercase tracking-[0.16em]"
                    style={{ color: "var(--on-photo-faint)" }}
                  >
                    Data source
                  </p>
                  <p
                    className="font-display mt-1.5 text-lg font-semibold leading-tight"
                    style={{ color: "var(--on-photo)" }}
                  >
                    NYC Open Data
                  </p>
                  <p
                    className="font-data text-[13px]"
                    style={{ color: "var(--on-photo-dim)" }}
                  >
                    311 Service Requests · erm2-nwe9
                  </p>
                </div>
              </div>
            </aside>
          </div>
        </div>

        {/* ---------- live report, straddling the hero's bottom edge ----------
            The negative margin pulls the card below the section, so the photo
            ends behind its upper half. The next section carries matching top
            padding to clear it.

            A client component because it may have to fetch: it renders the
            server-fetched cached item when there is one, and otherwise pulls a
            real score for the fallback address without holding up the page. */}
        <HeroSampleCard item={heroItem ?? null} fallback={fallback} />
      </section>

      {/* ===================== How it works ===================== */}
      <section className="mx-auto max-w-6xl px-4 pt-28 sm:px-6 lg:pt-36">
        <h2 className="font-data text-[11px] font-medium uppercase tracking-[0.18em] text-(--text-muted)">
          How it works
        </h2>
        {/* Numbered because these three are a real sequence - you cannot read a
            score before entering an address. */}
        <ol className="mt-6 grid gap-8 sm:grid-cols-3 sm:gap-6">
          {STEPS.map((s, i) => (
            <li
              key={s.title}
              className="border-t pt-4"
              style={{ borderColor: "var(--border-hairline)" }}
            >
              <span className="font-data text-sm font-medium text-(--brand-ink)">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 font-semibold text-(--text-primary)">
                {s.title}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-(--text-secondary)">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* ===================== What you get ===================== */}
      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-12 sm:grid-cols-3 sm:px-6">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="rounded-lg bg-(--surface-1) p-6"
            style={{
              boxShadow: "var(--shadow-sm)",
              border: "1px solid var(--border-hairline)",
            }}
          >
            <span
              className="flex h-10 w-10 items-center justify-center rounded-md"
              style={{
                color: `var(${f.inkVar})`,
                background: `color-mix(in srgb, var(${f.colorVar}) 14%, transparent)`,
              }}
            >
              <f.icon className="h-5 w-5" />
            </span>
            <h3 className="mt-4 font-semibold text-(--text-primary)">
              {f.title}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-(--text-secondary)">
              {f.body}
            </p>
          </div>
        ))}
      </section>

      {/* ===================== Recently checked / citywide baseline =====================
          Two different sections sharing one slot, chosen by what the backend
          actually holds. There is no third branch that fills the gap with
          invented reports - that is what this section used to be.

          Below MIN_CAROUSEL_ITEMS the carousel would be a duplicated one- or
          two-card loop, which reads as a bug. The baseline panel takes the slot
          instead: real measured citywide data, always available, and it answers
          what a score of 62 actually means. */}
      <section className="py-12">
        <div className="mx-auto mb-1 flex max-w-6xl flex-wrap items-end justify-between gap-x-6 gap-y-2 px-4 sm:px-6">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight text-(--text-primary)">
              {showCarousel
                ? "Uptown, downtown, and everywhere between"
                : "The citywide baseline"}
            </h2>
            <p className="mt-0.5 text-sm text-(--text-muted)">
              {showCarousel
                ? "What's living rent-free in the minds of current and future New Yorkers"
                : "What an ordinary NYC address looks like, and what every score here is measured against."}
            </p>
          </div>
          <Link
            href="/compare"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-(--brand-ink)"
          >
            Compare addresses
            <ArrowRightIcon className="h-4 w-4" />
          </Link>
        </div>

        {showCarousel ? (
          // Full-bleed: the carousel scrolls past the page gutters by design.
          <div className="px-4 sm:px-6">
            <FeaturedCarousel reports={carouselItems} />
          </div>
        ) : (
          <div className="mx-auto mt-4 max-w-6xl px-4 sm:px-6">
            <CitywideBaselinePanel />
          </div>
        )}
      </section>
    </main>
  );
}
