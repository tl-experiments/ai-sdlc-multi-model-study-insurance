import React, { useState } from "react";
import type { PassData } from "../../lib/types";

/**
 * Anchor the LLM cost against the alternative (human engineering hours) instead
 * of zero. A senior SDE in APAC costs ~$80–150/hr fully loaded; pick a midpoint
 * default + let the user adjust the assumption inline.
 *
 * "Hours to author this scope by hand" comes from a heuristic over LOC + file
 * count: ~30 LOC/hr sustainable for production-grade code with tests. We expose
 * the assumption so CFOs can sanity-check.
 */
const DEFAULT_SDE_RATE_USD = 110;        // fully-loaded senior SDE per-hour (APAC midpoint)
const DEFAULT_LOC_PER_HOUR = 30;         // industry-standard "production-grade with tests"

export function IndustryBenchmark({ passes }: { passes: PassData[] }) {
  const baseline = passes.find((p) => {
    const a = p.manifest.artifacts ?? {};
    return (p.manifest.total_cost_usd ?? 0) > 0 && a.build_ok === true && (a.tests_passed ?? 0) > 0 && (a.loc ?? 0) > 0;
  });

  const [sdeRate, setSdeRate] = useState(DEFAULT_SDE_RATE_USD);
  const [locPerHour, setLocPerHour] = useState(DEFAULT_LOC_PER_HOUR);

  if (!baseline) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Vs. human engineering cost</h2>
        <p className="text-sm text-slate-500">
          Will populate once a verified pass reports LOC counts.
        </p>
      </section>
    );
  }

  const loc = baseline.manifest.artifacts?.loc ?? 0;
  const hours = loc / locPerHour;
  const humanCost = hours * sdeRate;
  const llmCost = baseline.manifest.total_cost_usd ?? 0;

  // Pick the cheapest non-baseline verified pass for the orchestrated comparison
  const cheapest = passes
    .filter((p) => p.config.id !== baseline.config.id)
    .filter((p) => (p.manifest.total_cost_usd ?? 0) > 0 && p.manifest.artifacts?.build_ok === true)
    .sort((a, b) => (a.manifest.total_cost_usd ?? 0) - (b.manifest.total_cost_usd ?? 0))[0];
  const orchestratedCost = cheapest?.manifest.total_cost_usd ?? llmCost;

  const ratioBaseline = humanCost > 0 ? (humanCost / llmCost) : 0;
  const ratioOrchestrated = humanCost > 0 ? (humanCost / orchestratedCost) : 0;

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Vs. human engineering cost</h2>
      <p className="text-sm text-slate-500 mb-4">
        Equivalent SDE labor cost for the same scope at industry rates, alongside the model spend that produced it.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-3">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Human engineering</div>
          <div className="text-xl font-bold font-mono text-slate-800 mt-1">${humanCost.toFixed(0)}</div>
          <div className="text-xs text-slate-500 mt-0.5">~{hours.toFixed(0)} hrs × ${sdeRate}/hr</div>
        </div>
        <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-3">
          <div className="text-xs uppercase tracking-wider text-violet-700 font-semibold">
            {baseline.config.shortLabel}
          </div>
          <div className="text-xl font-bold font-mono text-violet-700 mt-1">${llmCost.toFixed(2)}</div>
          <div className="text-xs text-violet-600 mt-0.5">{ratioBaseline > 0 ? `${ratioBaseline.toFixed(0)}× cheaper` : ""}</div>
        </div>
        {cheapest && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-3">
            <div className="text-xs uppercase tracking-wider text-emerald-700 font-semibold">
              {cheapest.config.shortLabel}
            </div>
            <div className="text-xl font-bold font-mono text-emerald-700 mt-1">${orchestratedCost.toFixed(2)}</div>
            <div className="text-xs text-emerald-600 mt-0.5">{ratioOrchestrated > 0 ? `${ratioOrchestrated.toFixed(0)}× cheaper` : ""}</div>
          </div>
        )}
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-3">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Scope</div>
          <div className="text-xl font-bold font-mono text-slate-800 mt-1">{(loc ?? 0).toLocaleString()}</div>
          <div className="text-xs text-slate-500 mt-0.5">{baseline.manifest.artifacts?.files ?? "?"} files</div>
        </div>
      </div>

      <details className="mt-4 text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Assumptions (tunable)</summary>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 px-3 py-3 bg-slate-50 rounded-lg border border-slate-200">
          <label className="flex flex-col gap-1">
            <span className="text-slate-600 font-medium">Fully-loaded SDE rate (USD/hr)</span>
            <input
              type="number" min={20} max={500} step={5}
              value={sdeRate}
              onChange={(e) => setSdeRate(Number(e.target.value))}
              className="px-2 py-1 border border-slate-300 rounded font-mono"
            />
            <span className="text-slate-400 text-[10px]">APAC senior midpoint = $110/hr. Adjust to your geography.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-600 font-medium">LOC/hr (sustainable, production-grade)</span>
            <input
              type="number" min={5} max={200} step={1}
              value={locPerHour}
              onChange={(e) => setLocPerHour(Number(e.target.value))}
              className="px-2 py-1 border border-slate-300 rounded font-mono"
            />
            <span className="text-slate-400 text-[10px]">Industry-standard "with tests + review" = ~30 LOC/hr. Aggressive teams claim 50+.</span>
          </label>
        </div>
      </details>
    </section>
  );
}
