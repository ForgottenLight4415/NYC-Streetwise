const W = 260;
const H = 240;
const CX = 130;
const CY = 116;
const MAX_R = 84;
/** 25/50/75/100 — the 50 ring is singled out below because scores are
 *  literally anchored on the citywide median at that percentile. */
const RING_PERCENTS = [25, 50, 75, 100];
const LABEL_OFFSET = 20;
/** A score of 0 must not collapse the polygon to the center point — that
 *  reads as "no data" rather than "genuinely bad", and makes the shape
 *  unreadable when one axis is much worse than the others. */
const MIN_R_RATIO = 0.06;

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** Angle 0 points straight up; each subsequent axis goes clockwise. */
function pointAt(index: number, count: number, r: number): [number, number] {
  const theta = (index * 2 * Math.PI) / count;
  return [round1(CX + r * Math.sin(theta)), round1(CY - r * Math.cos(theta))];
}

function polygonPoints(count: number, r: number) {
  return Array.from({ length: count }, (_, i) => pointAt(i, count, r).join(","))
    .join(" ");
}

export interface RadarAxis {
  key: string;
  label: string;
  score: number;
  colorVar: string;
}

/**
 * The report's "neighborhood profile" — one glyph plotting every category's
 * score on the same six axes (five complaint/amenity categories plus
 * walkability).
 *
 * No chart library: TrendSparkline and ScoreMeter are both hand-rolled SVG
 * already, and one radar chart is not worth a dependency in a four-package
 * app. Renders nothing below three axes — a two-point radar has no shape to
 * read.
 *
 * The dashed ring at 50 is not decorative: every score here is
 * `100 - percentileFor(count)` (or the distance equivalent) anchored on the
 * CITYWIDE MEDIAN at the 50th percentile, so that ring is the one line on
 * this page that says "average for NYC" and means it literally.
 */
export function ScoreRadar({ axes }: { axes: RadarAxis[] }) {
  if (axes.length < 3) return null;

  const n = axes.length;
  const dataPoints = axes
    .map((a, i) => {
      const r = Math.max(MIN_R_RATIO * MAX_R, (a.score / 100) * MAX_R);
      return pointAt(i, n, r);
    });
  const dataPath = dataPoints.map((p) => p.join(",")).join(" ");

  const summary = axes.map((a) => `${a.label} ${a.score}`).join(", ");

  return (
    <div
      className="flex h-full flex-col gap-4 rounded-lg bg-(--surface-1) p-5 sm:p-6"
      style={{
        boxShadow: "var(--shadow-md)",
        border: "1px solid var(--border-hairline)",
      }}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-(--text-muted)">
        Neighborhood profile
      </p>

      <div className="@container flex flex-1 flex-col">
        <div className="flex h-full flex-col items-center justify-center gap-6 @[30rem]:flex-row">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Neighborhood profile, out of 100: ${summary}. Dashed ring marks the citywide median of 50.`}
            className="w-80 max-w-full shrink-0"
          >
            {RING_PERCENTS.map((pct) => {
              const r = (pct / 100) * MAX_R;
              const isMedian = pct === 50;
              return (
                <polygon
                  key={pct}
                  points={polygonPoints(n, r)}
                  fill="none"
                  stroke={isMedian ? "var(--baseline)" : "var(--gridline)"}
                  strokeWidth={isMedian ? 1.25 : 1}
                  strokeDasharray={isMedian ? "3 3" : undefined}
                />
              );
            })}

            {axes.map((_, i) => {
              const [x, y] = pointAt(i, n, MAX_R);
              return (
                <line
                  key={i}
                  x1={CX}
                  y1={CY}
                  x2={x}
                  y2={y}
                  stroke="var(--gridline)"
                  strokeWidth={1}
                />
              );
            })}

            {/* "NYC median" label, anchored beside the 50-ring on the first axis
                so it never overlaps the data polygon's usual top vertex. */}
            <text
              x={CX + 4}
              y={CY - 0.5 * MAX_R + 3}
              className="font-data"
              fontSize={7.5}
              fill="var(--text-muted)"
            >
              NYC median
            </text>

            <polygon
              points={dataPath}
              fill="var(--brand)"
              fillOpacity={0.18}
              stroke="var(--brand)"
              strokeWidth={2}
              strokeLinejoin="round"
            />

            {dataPoints.map(([x, y], i) => (
              <circle
                key={axes[i].key}
                cx={x}
                cy={y}
                r={3.5}
                fill={`var(${axes[i].colorVar}-ink)`}
              />
            ))}

            {axes.map((a, i) => {
              const [x, y] = pointAt(i, n, MAX_R + LABEL_OFFSET);
              const anchor = x < CX - 4 ? "end" : x > CX + 4 ? "start" : "middle";
              return (
                <text
                  key={a.key}
                  x={x}
                  y={y}
                  textAnchor={anchor}
                  dominantBaseline="middle"
                  fontSize={9}
                  fill="var(--text-secondary)"
                >
                  {a.label}
                </text>
              );
            })}
          </svg>

          {/* The chart's non-visual fallback and its own data table — not
              sr-only, since a legend that names every score is useful to every
              reader, not only assistive tech. */}
          <ul className="flex flex-row flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs @[30rem]:shrink-0 @[30rem]:flex-col @[30rem]:flex-nowrap @[30rem]:justify-start @[30rem]:gap-2">
            {axes.map((a) => (
              <li key={a.key} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: `var(${a.colorVar}-ink)` }}
                />
                <span className="text-(--text-secondary)">{a.label}</span>
                <span className="font-data font-medium text-(--text-primary)">
                  {a.score}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
