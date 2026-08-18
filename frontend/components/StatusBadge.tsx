import { AlertTriangleIcon, CheckCircleIcon, XCircleIcon } from "./icons";
import { BAND_LABEL, BAND_VAR } from "@/lib/score";
import type { ScoreBand } from "@/lib/types";

const ICON: Record<ScoreBand, React.ComponentType<{ className?: string }>> = {
  good: CheckCircleIcon,
  fair: AlertTriangleIcon,
  poor: XCircleIcon,
};

export function StatusBadge({
  band,
  text,
}: {
  band: ScoreBand;
  text?: string;
}) {
  const Icon = ICON[band];
  // Label and icon take the ink value so they clear 4.5:1; the wash behind
  // them is mixed from the saturated one so the badge keeps its hue.
  const color = `var(${BAND_VAR[band]})`;
  const ink = `var(${BAND_VAR[band]}-ink)`;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        color: ink,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      <Icon className="h-3.5 w-3.5" />
      {text ?? BAND_LABEL[band]}
    </span>
  );
}
