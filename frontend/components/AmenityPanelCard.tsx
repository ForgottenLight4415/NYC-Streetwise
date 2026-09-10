import { useMemo } from "react";
import { AmenityMetricRows } from "./AmenityMetricRows";
import { PanelShell } from "./PanelShell";
import { WhyThisScore } from "./WhyThisScore";
import { explainAmenity, formatDistance, nearestMetric } from "@/lib/amenities";
import type { AmenityMetric, Confidence, ScoreBand } from "@/lib/types";

/**
 * The amenity sibling to ScorePanelCard - same shell, plus its own "Why this
 * score?" disclosure computed client-side (explainAmenity) rather than
 * fetched: none of the four amenity tiers ever gets an AI or backend-computed
 * explanation (see CLAUDE.md's AI Explanation Layer section), so this is the
 * only place that text comes from.
 */
export function AmenityPanelCard({
  icon,
  title,
  description,
  colorVar,
  panel,
  onOpenBucket,
  onHoverBucket,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  colorVar: string;
  panel: {
    score: number;
    band: ScoreBand;
    radiusMeters: number;
    metrics: Record<string, AmenityMetric>;
    confidence: Confidence;
    confidenceReason: string | null;
  };
  /** Forwarded straight to AmenityMetricRows - see its own doc comment. */
  onOpenBucket?: (bucket: string) => void;
  /** Forwarded straight to AmenityMetricRows - see its own doc comment. */
  onHoverBucket?: () => void;
}) {
  // Only used for the "nothing at all" case - when something was found, the
  // Nearest by type table below already shows it, so no separate summary
  // sentence is needed here.
  const nearest = nearestMetric(panel.metrics);

  const summary = nearest ? null : (
    <p>Nothing within {formatDistance(panel.radiusMeters)}.</p>
  );

  const explanation = useMemo(
    () => explainAmenity(title, panel.score, panel.metrics),
    [title, panel.score, panel.metrics],
  );

  return (
    <PanelShell
      icon={icon}
      title={title}
      description={description}
      colorVar={colorVar}
      score={panel.score}
      band={panel.band}
      confidence={panel.confidence}
      confidenceReason={panel.confidenceReason}
      summary={summary}
      compact
    >
      <div>
        <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-(--text-muted)">
          Nearest by type
        </p>
        <AmenityMetricRows
          metrics={panel.metrics}
          radiusMeters={panel.radiusMeters}
          onOpenBucket={onOpenBucket}
          onHoverBucket={onHoverBucket}
        />
      </div>

      <WhyThisScore explanation={explanation} />
    </PanelShell>
  );
}
