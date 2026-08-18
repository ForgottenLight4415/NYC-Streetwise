import { BAND_VAR } from "@/lib/score";
import type { ScoreBand } from "@/lib/types";

export function ScoreMeter({
  score,
  band,
  size = 128,
}: {
  score: number;
  band: ScoreBand;
  size?: number;
}) {
  const stroke = size * 0.09;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  const color = `var(${BAND_VAR[band]})`;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--gridline)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 700ms ease-out" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-data font-semibold text-(--text-primary)"
          style={{ fontSize: size * 0.28 }}
        >
          {score}
        </span>
        <span className="font-data text-[10px] tracking-wide text-(--text-muted)">
          / 100
        </span>
      </div>
    </div>
  );
}
