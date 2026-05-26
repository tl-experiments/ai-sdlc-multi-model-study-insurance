import React from "react";
import type { PassData, StudyData } from "../../lib/types";
import { pipelineOk } from "../../lib/passGate";

/**
 * Auto-generated 2-3 sentence executive narrative, read aloud during a 30-second
 * pitch. Saves the presenter from having to interpret. Driven purely by manifest
 * data so it can't go stale.
 */
export function NarrativeParagraph({ study }: { study: StudyData }) {
  const verified = study.passes.filter(pipelineOk);

  if (verified.length < 2) {
    return (
      <section className="rounded-2xl bg-amber-50 border border-amber-200 px-5 py-4">
        <div className="text-xs uppercase tracking-wider text-amber-700 font-semibold">Executive narrative</div>
        <div className="text-sm text-amber-900 mt-1">
          Will populate once at least 2 passes have verified builds + tests. Right now: {verified.length}/{study.passes.length} verified.
        </div>
      </section>
    );
  }

  const baseline = verified[0];
  const cheapest = verified
    .filter((p) => p.config.id !== baseline.config.id)
    .sort((a, b) => (a.manifest.total_cost_usd ?? 0) - (b.manifest.total_cost_usd ?? 0))[0];

  const a = baseline.manifest.total_cost_usd ?? 0;
  const b = cheapest.manifest.total_cost_usd ?? 0;
  const pct = a > 0 ? (1 - b / a) * 100 : 0;
  const qa = avgQuality(baseline.manifest.quality_scores);
  const qb = avgQuality(cheapest.manifest.quality_scores);
  const parityClause =
    qa !== null && qb !== null
      ? Math.abs(qa - qb) <= 0.25
        ? `Quality score is within ±5% of the premium baseline (${qa.toFixed(2)} → ${qb.toFixed(2)} on a 1–5 scale).`
        : qb > qa
          ? `Quality score actually improved (${qa.toFixed(2)} → ${qb.toFixed(2)} on a 1–5 scale).`
          : `Quality dropped from ${qa.toFixed(2)} to ${qb.toFixed(2)} (1–5 scale) — a ${((qa - qb) / qa * 100).toFixed(1)}% regression worth tradeoff review.`
      : `Quality judge re-run is pending.`;

  const filesClause =
    baseline.manifest.artifacts?.files
      ? ` across ${baseline.manifest.artifacts.files} files / ${(baseline.manifest.artifacts.loc ?? 0).toLocaleString()} LOC`
      : "";

  const narrative = `On the ${study.config.shortLabel} case study${filesClause}, the ${baseline.config.shortLabel} baseline spent $${a.toFixed(2)} authoring the codebase end-to-end. Routing the same scope through ${cheapest.config.shortLabel} — keeping premium-judgment phases on Opus and delegating mechanical work to a cost-efficient tier — produced a verified build at $${b.toFixed(2)}, a ${pct.toFixed(1)}% reduction. ${parityClause}`;

  return (
    <section className="rounded-2xl bg-white border-l-4 border-violet-500 border border-slate-200 px-5 py-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">Executive narrative</div>
      <p className="text-sm md:text-base text-slate-800 leading-relaxed">{narrative}</p>
    </section>
  );
}

function avgQuality(q?: Record<string, number>): number | null {
  if (!q) return null;
  const vals = Object.values(q).filter((v) => typeof v === "number" && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
