import React, { useMemo, useState } from "react";
import type { LoadedData } from "../lib/loadTelemetry";
import { simulate } from "../lib/simulator";
import { fetchArtifact } from "../lib/loadTelemetry";
import type { TelemetryEvent, StudyData } from "../lib/types";
import { PolicyDetail } from "../components/PolicyDetail";
import { CacheHitChart } from "../components/engineering/CacheHitChart";
import { RetryHistogram } from "../components/engineering/RetryHistogram";
import { LatencyDistribution } from "../components/engineering/LatencyDistribution";
import { RoundTripDrilldown } from "../components/engineering/RoundTripDrilldown";
import { ReproducibilityBlock } from "../components/engineering/ReproducibilityBlock";
import { TokensByModelPivot } from "../components/engineering/TokensByModelPivot";

export function EngineeringView({ data, study }: { data: LoadedData; study: StudyData }) {
  const [selectedPassId, setSelectedPassId] = useState<string>(study.passes[study.passes.length - 1].config.id);
  const selectedPass = study.passById[selectedPassId];

  const [phaseFilter, setPhaseFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  // (what-if simulator removed; state retained as unused-var-free no-op)

  const [cmpA, setCmpA] = useState<string>("opus-only");
  const [cmpB, setCmpB] = useState<string>("opus-plus-flash");
  const [diffFile, setDiffFile] = useState<string>("src/employees/employees.controller.ts");
  const [contentByPass, setContentByPass] = useState<Record<string, string>>({});

  const allEvents = useMemo(() => study.passes.flatMap((p) => p.events), [data]);
  const phases = uniq(allEvents.map((e) => e.phase));
  const models = uniq(allEvents.map((e) => e.model));
  const modules = uniq(allEvents.map((e) => e.module));

  const fp = (events: TelemetryEvent[]) =>
    events
      .filter((e) => !phaseFilter || e.phase === phaseFilter)
      .filter((e) => !modelFilter || e.model === modelFilter)
      .filter((e) => !moduleFilter || e.module === moduleFilter);

  const fSelected = fp(selectedPass.events);

  const pivot = useMemo(() => {
    const ms = uniq(fSelected.map((e) => e.model));
    const ps = uniq(fSelected.map((e) => e.phase));
    const rows = ps.map((p) => {
      const row: any = { phase: p };
      for (const m of ms) {
        row[m] = +(fSelected.filter((e) => e.phase === p && e.model === m).reduce((a, b) => a + b.cost_usd, 0)).toFixed(4);
      }
      return row;
    });
    return { rows, models: ms };
  }, [fSelected]);

  const ruleFires = useMemo(() => {
    const m = new Map<string, { count: number; reason: string }>();
    for (const e of fSelected) {
      const k = `${e.routing.rule_index} — ${e.routing.rule_reason}`;
      const prev = m.get(k) ?? { count: 0, reason: e.routing.rule_reason };
      prev.count++;
      m.set(k, prev);
    }
    return Array.from(m.entries()).map(([k, v]) => ({ rule: k, count: v.count })).sort((a, b) => b.count - a.count);
  }, [fSelected]);

  // (sim memoization removed alongside the what-if simulator)


  const baselineEvents = study.passes[0].events;
  const cmpResultA = useMemo(() => data.policies[cmpA] ? simulate(baselineEvents, data.policies[cmpA]) : null, [data, cmpA, baselineEvents]);
  const cmpResultB = useMemo(() => data.policies[cmpB] ? simulate(baselineEvents, data.policies[cmpB]) : null, [data, cmpB, baselineEvents]);

  async function loadDiff() {
    const entries = await Promise.all(
      study.passes.map(async (p) => [p.config.id, await fetchArtifact(study.config.id, p.config.id, diffFile)] as const)
    );
    setContentByPass(Object.fromEntries(entries));
  }

  return (
    <div className="space-y-6">
      <section className="card flex flex-wrap items-end gap-4">
        <div>
          <label className="label mb-1 block">Active pass</label>
          <div className="flex gap-1">
            {study.passes.map((p) => (
              <button
                key={p.config.id}
                onClick={() => setSelectedPassId(p.config.id)}
                className={`px-3 py-1.5 rounded text-sm font-medium border ${
                  p.config.id === selectedPassId
                    ? "bg-ink text-white border-ink"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                }`}
              >{p.config.shortLabel}</button>
            ))}
          </div>
        </div>
        <FilterSelect label="Phase"  value={phaseFilter}  onChange={setPhaseFilter}  options={phases} />
        <FilterSelect label="Model"  value={modelFilter}  onChange={setModelFilter}  options={models} />
        <FilterSelect label="Module" value={moduleFilter} onChange={setModuleFilter} options={modules} />
        <button
          className="ml-auto px-3 py-2 text-sm border border-slate-200 rounded hover:bg-slate-50"
          onClick={() => { setPhaseFilter(""); setModelFilter(""); setModuleFilter(""); }}
        >Reset filters</button>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Cost pivot — phase × model ({selectedPass.config.shortLabel})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200">
                <th className="py-2 pr-4">Phase</th>
                {pivot.models.map((m) => <th key={m} className="py-2 pr-4">{m}</th>)}
                <th className="py-2">Row total</th>
              </tr>
            </thead>
            <tbody>
              {pivot.rows.map((r) => {
                const rowTotal = pivot.models.reduce((a, m) => a + (r[m] ?? 0), 0);
                return (
                  <tr key={r.phase} className="border-b border-slate-100">
                    <td className="py-2 pr-4 font-medium">{r.phase}</td>
                    {pivot.models.map((m) => <td key={m} className="py-2 pr-4">${(r[m] ?? 0).toFixed(4)}</td>)}
                    <td className="py-2 font-semibold">${rowTotal.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Side-by-side policy comparison</h2>
        <p className="text-sm text-slate-500 mb-4">
          Replay the Pass-1 baseline events under any two policies. No LLM calls — instant cost projection.
        </p>
        <div className="grid lg:grid-cols-2 gap-4">
          {([
            ["A", cmpA, setCmpA, cmpResultA] as const,
            ["B", cmpB, setCmpB, cmpResultB] as const,
          ]).map(([k, val, setter, res]) => (
            <div key={k} className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="bg-slate-50 px-4 py-2 flex items-center gap-2 border-b border-slate-200">
                <span className="label">Policy {k}</span>
                <select value={val} onChange={(e) => setter(e.target.value)} className="border border-slate-200 rounded px-2 py-1 text-sm flex-1">
                  {Object.keys(data.policies).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="p-4">
                {res ? (
                  <>
                    <div className="text-3xl font-bold">${res.total_cost_usd.toFixed(4)}</div>
                    <div className="text-xs text-slate-500 mb-3">simulated against {baselineEvents.length} baseline events</div>
                    <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">By model</div>
                    {Object.entries(res.per_model).map(([m, v]) => (
                      <div key={m} className="flex justify-between text-sm py-0.5">
                        <span className="font-mono text-xs">{m}</span>
                        <span className="font-mono">${(v as number).toFixed(4)}</span>
                      </div>
                    ))}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-slate-600">Show policy rules</summary>
                      <div className="mt-2 pt-2 border-t border-slate-100">
                        <PolicyDetail policy={data.policies[val]} />
                      </div>
                    </details>
                  </>
                ) : <div className="text-slate-500">Policy not found</div>}
              </div>
            </div>
          ))}
        </div>
        {cmpResultA && cmpResultB && (
          <div className="mt-4 text-center text-sm">
            Delta:{" "}
            <span className={`font-bold ${cmpResultB.total_cost_usd < cmpResultA.total_cost_usd ? "text-emerald-600" : "text-rose-600"}`}>
              ${(cmpResultB.total_cost_usd - cmpResultA.total_cost_usd).toFixed(4)}
              {" "}({((cmpResultB.total_cost_usd / cmpResultA.total_cost_usd - 1) * 100).toFixed(1)}%)
            </span>
            {" "}— Policy B vs Policy A
          </div>
        )}
      </section>

      <section>
        <div className="card">
          <h2 className="text-lg font-semibold mb-1">Rule-firing heatmap</h2>
          <p className="text-sm text-slate-500 mb-4">Which policy rules actually fired in {selectedPass.config.shortLabel}. Zero-count rules are removal candidates.</p>
          <div className="space-y-1 text-sm max-h-72 overflow-auto">
            {ruleFires.map((r) => (
              <div key={r.rule} className="flex items-center gap-2">
                <div className="w-32 h-4 bg-slate-100 rounded relative overflow-hidden">
                  <div className="bg-gemini h-full" style={{ width: `${Math.min(100, (r.count / (ruleFires[0]?.count || 1)) * 100)}%` }} />
                </div>
                <span className="font-mono text-xs">{r.count}</span>
                <span className="text-slate-600 truncate flex-1">{r.rule}</span>
              </div>
            ))}
          </div>
        </div>

        {/* What-if simulator removed per product feedback — the side-by-side policy
            comparison above already covers the same use-case more directly. */}
      </section>

      {/* ────── Phase 2 forensic-grade rigor additions ────── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CacheHitChart events={fSelected} />
        <RetryHistogram events={fSelected} />
      </section>

      <LatencyDistribution events={fSelected} />

      <TokensByModelPivot events={fSelected} />

      <RoundTripDrilldown events={fSelected} />

      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Per-call audit ({selectedPass.config.shortLabel}, filtered)</h2>
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left border-b border-slate-200">
                <th className="py-1 pr-2">Task ID</th>
                <th className="py-1 pr-2">Phase</th>
                <th className="py-1 pr-2">Module</th>
                <th className="py-1 pr-2">Model</th>
                <th className="py-1 pr-2">Cost</th>
                <th className="py-1 pr-2">Tokens (in/cached/out)</th>
                <th className="py-1 pr-2">Latency</th>
                <th className="py-1">Reason</th>
              </tr>
            </thead>
            <tbody>
              {fSelected.slice(0, 300).map((e) => (
                <tr key={e.task_id} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-mono">{e.task_id}</td>
                  <td className="py-1 pr-2">{e.phase}</td>
                  <td className="py-1 pr-2">{e.module}</td>
                  <td className="py-1 pr-2">{e.model}</td>
                  <td className="py-1 pr-2">${e.cost_usd.toFixed(5)}</td>
                  <td className="py-1 pr-2">{e.input_tokens}/{e.input_tokens_cached}/{e.output_tokens}</td>
                  <td className="py-1 pr-2">{e.latency_ms}ms</td>
                  <td className="py-1 text-slate-500">{e.routing.rule_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Per-file artifact diff across passes</h2>
        <div className="flex items-center gap-3 mb-3">
          <select value={diffFile} onChange={(e) => setDiffFile(e.target.value)} className="border border-slate-200 rounded px-2 py-1 text-sm">
            <option value="src/employees/employees.controller.ts">src/employees/employees.controller.ts</option>
            <option value="src/employees/employees.service.ts">src/employees/employees.service.ts</option>
            <option value="src/leave-requests/leave-requests.service.ts">src/leave-requests/leave-requests.service.ts</option>
            <option value="test/employees.e2e.spec.ts">test/employees.e2e.spec.ts</option>
            <option value="web/src/pages/LeaveRequests.tsx">web/src/pages/LeaveRequests.tsx</option>
            <option value="security_review.md">security_review.md</option>
          </select>
          <button onClick={loadDiff} className="px-3 py-1 text-sm bg-ink text-white rounded">Load across all passes</button>
        </div>
        <div className={`grid gap-3 ${study.passes.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
          {study.passes.map((p) => (
            <pre key={p.config.id} className="text-xs bg-slate-50 p-3 rounded max-h-96 overflow-auto whitespace-pre-wrap">
              <span className="text-slate-400">// {p.config.shortLabel}</span>{"\n"}{contentByPass[p.config.id] || "(click Load)"}
            </pre>
          ))}
        </div>
      </section>

      {/* Reproducibility block — bottom of Engineering view so reviewers can */}
      {/* screen-capture the pinned identifiers alongside the data above.    */}
      <ReproducibilityBlock
        pass={selectedPass}
        repoUrl="https://github.com/tl-experiments/ai-sdlc-multi-model-study-insurance"
      />
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <label className="flex flex-col text-sm">
      <span className="label mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="border border-slate-200 rounded px-2 py-1">
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
