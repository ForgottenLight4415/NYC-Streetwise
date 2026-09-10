"use client";

import { useRef, useState } from "react";
import type { TrendPoint } from "@/lib/types";

const W = 320;
const H = 108;
const PAD_TOP = 10;
const PAD_BOTTOM = 8;
const PAD_LEFT = 22;
const PAD_RIGHT = 6;
const BAR_WIDTH_RATIO = 0.6;

const MONTH_SHORT = [
  "",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function monthShort(month: string) {
  const [, m] = month.split("-");
  return MONTH_SHORT[Number(m)];
}

/** "Sep '24" - over a 24-month span the bare month name is ambiguous, since
 *  each one appears twice on the axis. */
function monthWithYear(month: string | undefined) {
  if (!month) return "";
  const [y] = month.split("-");
  return `${monthShort(month)} '${y.slice(2)}`;
}

export function TrendSparkline({
  data,
  colorVar,
}: {
  data: TrendPoint[];
  colorVar: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const color = `var(${colorVar})`;

  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  const rawMax = Math.max(1, ...data.map((d) => d.count));
  // Round the axis ceiling up to a friendlier number than the raw max
  // (e.g. 7 -> 8, 13 -> 15) so the top gridline reads as a clean reference.
  const step = rawMax <= 5 ? 1 : rawMax <= 20 ? 5 : 10;
  const axisMax = Math.max(step, Math.ceil(rawMax / step) * step);
  const midTick = Math.round(axisMax / 2);
  const ticks = Array.from(new Set([0, midTick, axisMax])).sort(
    (a, b) => a - b,
  );

  const yFor = (count: number) => PAD_TOP + chartH - (count / axisMax) * chartH;
  const baseline = PAD_TOP + chartH;
  const bandWidth = data.length > 0 ? chartW / data.length : 0;
  const barWidth = bandWidth * BAR_WIDTH_RATIO;

  const bars = data.map((d, i) => {
    const bandStart = PAD_LEFT + i * bandWidth;
    const barX = bandStart + (bandWidth - barWidth) / 2;
    const barY = yFor(d.count);
    return {
      ...d,
      bandStart,
      x: barX,
      y: barY,
      centerX: bandStart + bandWidth / 2,
    };
  });

  function handleMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || bars.length === 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.min(
      bars.length - 1,
      Math.max(0, Math.floor((relX - PAD_LEFT) / bandWidth)),
    );
    // Only when the pointer crosses into a different month. A pointermove fires
    // per frame (~120Hz on a trackpad) but a 9-month chart has nine bands, so
    // the overwhelming majority of moves land in the band already highlighted.
    // React bails out on an identical value, so this turns a continuous re-render
    // of the whole SVG - gridlines, up to 24 rects, and the tooltip, times two
    // charts on the report and four on the compare view - into one render per
    // band crossed. It also keeps the getBoundingClientRect above cheap: with no
    // re-render in between, the layout is clean and the browser serves it from
    // cache instead of recomputing it.
    setHoverIdx((prev) => (prev === idx ? prev : idx));
  }

  const hovered = hoverIdx !== null ? bars[hoverIdx] : null;
  const totalComplaints = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="relative">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] text-(--text-muted)">
          Complaints per month
        </span>
        <span className="text-[10px] text-(--text-muted)">
          {totalComplaints} total
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none"
        role="img"
        aria-label={`Complaints per month over the last ${data.length} months, ranging from 0 to ${rawMax}. ${
          hovered
            ? `Currently showing ${hovered.count} complaints in ${monthWithYear(hovered.month)}.`
            : ""
        }`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              y1={yFor(tick)}
              x2={W - PAD_RIGHT}
              y2={yFor(tick)}
              stroke="var(--gridline)"
              strokeWidth="1"
              strokeDasharray={tick === 0 ? undefined : "2 2"}
            />
            <text
              x={PAD_LEFT - 5}
              y={yFor(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              style={{ fill: "var(--text-muted)" }}
              fontSize="9"
            >
              {tick}
            </text>
          </g>
        ))}

        {bars.map((b, i) => (
          <rect
            key={b.month}
            x={b.x}
            y={b.y}
            width={Math.max(1, barWidth)}
            height={Math.max(0, baseline - b.y)}
            rx="1.5"
            fill={color}
            opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.45}
          />
        ))}

        {hovered && (
          <rect
            x={hovered.bandStart}
            y={PAD_TOP}
            width={bandWidth}
            height={chartH}
            fill={color}
            opacity="0.06"
          />
        )}
      </svg>

      <div className="font-data mt-1 flex justify-between pl-5.5 text-[10px] text-(--text-muted)">
        <span>{monthWithYear(data[0]?.month)}</span>
        <span>{monthWithYear(data[data.length - 1]?.month)}</span>
      </div>

      {hovered && (
        <div
          className="font-data pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-2 py-1 text-xs shadow-sm"
          style={{
            // Clamped away from the edges: the tooltip is centred on the bar,
            // so at the first and last month half of it hung outside the card.
            left: `${Math.min(82, Math.max(18, (hovered.centerX / W) * 100))}%`,
            top: `${(hovered.y / H) * 100 - 4}%`,
            background: "var(--surface-1)",
            borderColor: "var(--border-hairline)",
            color: "var(--text-primary)",
          }}
        >
          <span className="font-medium">{hovered.count}</span>{" "}
          <span className="text-(--text-muted)">
            {hovered.count === 1 ? "complaint" : "complaints"} ·{" "}
            {monthWithYear(hovered.month)}
          </span>
        </div>
      )}
    </div>
  );
}
