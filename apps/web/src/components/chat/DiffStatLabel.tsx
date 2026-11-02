import { memo } from "react";
import type { TurnDiffStatSides } from "~/lib/turnDiffTree";
import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  if (value < 999_500_000) {
    const m = value / 1_000_000;
    return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
  }
  const b = value / 1_000_000_000;
  return `${b < 10 ? b.toFixed(1).replace(/\.0$/, "") : Math.round(b)}b`;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  /** Shows one side for a file that was only added or only deleted. */
  sides?: TurnDiffStatSides;
  className?: string;
  layout?: "aligned" | "inline";
}) {
  const { additions, deletions, sides = "both", className, layout = "aligned" } = props;
  const showAdditions = sides !== "deletions";
  const showDeletions = sides !== "additions";
  // The aligned grid keeps an empty cell, so counts stay in their columns.
  const emptyCell = layout === "aligned" ? <span aria-hidden="true" /> : null;
  return (
    <span
      role="group"
      aria-label={[
        showAdditions ? `${additions} additions` : null,
        showDeletions ? `${deletions} deletions` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      className={cn(
        layout === "inline"
          ? "inline-flex items-center gap-1 tabular-nums align-middle"
          : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle",
        className,
      )}
    >
      {showAdditions ? (
        <span aria-hidden="true" className="font-mono text-diff-addition-foreground">
          +{formatCompactDiffCount(additions)}
        </span>
      ) : (
        emptyCell
      )}
      {showDeletions ? (
        <span aria-hidden="true" className="font-mono text-diff-deletion-foreground">
          -{formatCompactDiffCount(deletions)}
        </span>
      ) : (
        emptyCell
      )}
    </span>
  );
});
