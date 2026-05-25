import React, { useMemo, useState } from "react";
import type { PassData } from "../../lib/types";

/**
 * Cost-at-scale projector. Takes the verified passes and an N multiplier slider,
 * and shows "if this team ships N×, you'd pay X with baseline vs Y with orchestrated".
 *
 * Reframes the savings from pocket change ($4) to budget item ($40K).
 *
 * Slider snaps to 1, 10, 100, 1_000, 10_000 (log scale).
 */
const SCALES = [1, 10, 100, 1_000, 10_000];

export function CostAtScaleSlider({ passes }: { passes: PassData[] }) {
  const verified = useMemo(
    () => passes.filter((p) => {
      const a = p.manifest.artifacts ?? {};
      return (p.manifest.total_cost_usd ?? 0) > 0 && a.build_ok === true && (a.tests_passed ?? 0) > 0;
    }),
    [passes],
  );

  const baseline = verified[0];
  const cheapest = verified
    .filter((p) => p.config.id !== baseline?.config.id)
    .sort((a, b) => (a.manifest.total_cost_usd ?? 0) - (b.manifest.total_cost_usd ?? 0))[0];

  const [scaleIdx, setScaleIdx] = useState(2); // default to 100×

  if (!baseline || !cheapest) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Cost projected at scale</h2>
        <p className="text-sm text-slate-500">
          Needs ≥2 verified passes (baseline + at least one orchestrated). Currently {verified.length}.
        </p>
      </section>
    );
  }

  const n = SCALES[scaleIdx];
  const a = (baseline.manifest.total_cost_usd ?? 0) * n;
  const b = (cheapest.manifest.total_cost_usd ?? 0) * n;
  const savings = a - b;

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Cost projected at scale</h2>
      <p className="text-sm text-slate-500 mb-4">
        If your team ships {n.toLocaleString()}× this scope per year, your model spend is:
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-4">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            {baseline.config.shortLabel}
          </div>
          <div className="text-2xl md:text-3xl font-bold font-mono text-slate-700 mt-1">${formatMoney(a)}</div>
          <div className="text-xs text-slate-500 mt-1">baseline at {n.toLocaleString()}× scale</div>
        </div>
        <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-4">
          <div className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">
            {cheapest.config.shortLabel}
          </div>
          <div className="text-2xl md:text-3xl font-bold font-mono text-emerald-700 mt-1">${formatMoney(b)}</div>
          <div className="text-xs text-emerald-600 mt-1">orchestrated at {n.toLocaleString()}× scale</div>
        </div>
        <div className="rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-50 border border-emerald-300 px-4 py-4">
          <div className="text-xs uppercase tracking-wider text-emerald-800 font-semibold">Annual savings</div>
          <div className="text-2xl md:text-3xl font-bold font-mono text-emerald-700 mt-1">${formatMoney(savings)}</div>
          <div className="text-xs text-emerald-700 mt-1">budget you can redirect</div>
        </div>
      </div>

      <div className="mt-5">
        <label className="block text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
          Scope multiplier
        </label>
        <input
          type="range" min={0} max={SCALES.length - 1} step={1}
          value={scaleIdx}
          onChange={(e) => setScaleIdx(Number(e.target.value))}
          className="w-full accent-violet-600"
        />
        <div className="flex justify-between text-xs text-slate-500 mt-1 font-mono">
          {SCALES.map((s, i) => (
            <span key={s} className={i === scaleIdx ? "text-violet-700 font-bold" : ""}>
              {s.toLocaleString()}×
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  return n.toFixed(2);
}
