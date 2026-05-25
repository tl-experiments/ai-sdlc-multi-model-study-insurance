import React from "react";
import type { PassData } from "../../lib/types";

/**
 * Board-deck hero metric. Reads exactly two passes from the study —
 * the baseline (passes[0], typically Opus-only) and the "cheapest verified"
 * pass — and renders a single line:
 *
 *     $90.00  →  $4.20    ·    −95.3%    ·    ✓ quality parity
 *
 * Designed to be the first thing a CXO reads. If no orchestrated pass is
 * verified yet, falls back to a placeholder bar with explicit messaging.
 */
export function HeroStrip({ passes }: { passes: PassData[] }) {
  const verified = passes.filter(verifiedPass);
  if (verified.length === 0) {
    return (
      <section className="rounded-2xl bg-slate-50 border border-slate-200 px-6 py-4 text-center">
        <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Headline result</div>
        <div className="text-sm text-slate-600 mt-1">
          Will appear here once at least one pass has a verified build + passing tests.
        </div>
      </section>
    );
  }

  const baseline = verified[0];
  // pick the cheapest verified pass that ISN'T the baseline (the "killer" comparison)
  const cheapest = verified
    .filter((p) => p.config.id !== baseline.config.id)
    .sort((a, b) => (a.manifest.total_cost_usd ?? 0) - (b.manifest.total_cost_usd ?? 0))[0]
    ?? baseline;

  const a = baseline.manifest.total_cost_usd ?? 0;
  const b = cheapest.manifest.total_cost_usd ?? 0;
  const pct = a > 0 ? ((1 - b / a) * 100) : 0;

  // Quality parity logic: average judge score within ±5% of baseline?
  const qa = avgQuality(baseline.manifest.quality_scores);
  const qb = avgQuality(cheapest.manifest.quality_scores);
  const parity =
    qa !== null && qb !== null
      ? Math.abs(qa - qb) <= 0.25     // <=0.25 on a 1-5 scale ≈ ±5%
      : null;
  const verdict =
    parity === null ? "quality pending"
      : parity ? "quality parity"
      : qb > qa ? "quality improved"
      : "quality regressed";
  const verdictColor =
    parity === null ? "text-slate-500 bg-slate-100"
      : parity ? "text-emerald-700 bg-emerald-100"
      : qb > qa ? "text-emerald-700 bg-emerald-100"
      : "text-amber-700 bg-amber-100";

  return (
    <section className="rounded-2xl bg-gradient-to-r from-violet-50 via-blue-50 to-cyan-50 border border-violet-200 px-6 py-5 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold text-center">Headline result</div>
      <div className="mt-2 flex flex-col md:flex-row items-center justify-center gap-3 md:gap-6">
        <div className="text-center">
          <div className="text-3xl md:text-4xl font-bold text-slate-800 font-mono">${a.toFixed(2)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{baseline.config.shortLabel}</div>
        </div>
        <div className="text-2xl text-slate-400 hidden md:block">→</div>
        <div className="text-center">
          <div className="text-3xl md:text-4xl font-bold text-emerald-600 font-mono">${b.toFixed(2)}</div>
          <div className="text-xs text-slate-500 mt-0.5">{cheapest.config.shortLabel}</div>
        </div>
        <div className="hidden md:block w-px h-12 bg-slate-300" />
        <div className="text-center">
          <div className={`text-2xl md:text-3xl font-bold ${pct > 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {pct > 0 ? "−" : "+"}{Math.abs(pct).toFixed(1)}%
          </div>
          <div className="text-xs text-slate-500 mt-0.5">savings</div>
        </div>
        <div className="hidden md:block w-px h-12 bg-slate-300" />
        <div className="text-center">
          <span className={`pill text-sm font-semibold px-3 py-1 ${verdictColor}`}>✓ {verdict}</span>
        </div>
      </div>
    </section>
  );
}

function verifiedPass(p: PassData): boolean {
  const a = p.manifest.artifacts ?? {};
  return !!p.manifest.total_cost_usd && p.manifest.total_cost_usd > 0
      && a.build_ok === true
      && (a.tests_passed ?? 0) > 0;
}

function avgQuality(q?: Record<string, number>): number | null {
  if (!q) return null;
  const vals = Object.values(q).filter((v) => typeof v === "number" && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
