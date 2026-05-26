import React, { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import type { LoadedData } from "../lib/loadTelemetry";
import type { PassData, StudyData } from "../lib/types";
import { Modal } from "../components/Modal";
import { PolicyDetail } from "../components/PolicyDetail";
import { ExperimentIntro } from "../components/ExperimentIntro";
import { HeroStrip } from "../components/cxo/HeroStrip";
import { QualityCostGrid } from "../components/cxo/QualityCostGrid";
import { CostAtScaleSlider } from "../components/cxo/CostAtScaleSlider";
import { VerifiedByBadges } from "../components/cxo/VerifiedByBadges";
import { NarrativeParagraph } from "../components/cxo/NarrativeParagraph";
import { IndustryBenchmark } from "../components/cxo/IndustryBenchmark";

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

const HEADER_BG: Record<string, string> = {
  violet: "bg-violet-600 text-white",
  blue: "bg-blue-600 text-white",
  cyan: "bg-cyan-600 text-white",
};
const HEADER_BORDER: Record<string, string> = {
  violet: "border-violet-200",
  blue: "border-blue-200",
  cyan: "border-cyan-200",
};
const MODEL_COLORS: Record<string, string> = {
  "claude-opus-4-7": "#7c3aed",
  "claude-opus-4-20250514": "#7c3aed",
  "gemini-2.5-pro": "#2563eb",
  "gemini-3.1-pro": "#2563eb",
  "gemini-3.5-flash": "#0891b2",
  "gemini-2.5-flash": "#0891b2",
};

export function ExecutiveView({ data, study }: { data: LoadedData; study: StudyData }) {
  const [openPass, setOpenPass] = useState<PassData | null>(null);
  const baseline = study.passes[0];
  const baselineCost = baseline.manifest.total_cost_usd ?? 0;

  return (
    <div className="space-y-6">
      <ExperimentIntro />

      {/* ────── CXO enrichments — board-deck-ready hero strip ────── */}
      <HeroStrip passes={study.passes} />

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {study.passes.map((pass) => (
          <PassCard key={pass.config.id} pass={pass} baselineCost={baselineCost} onClick={() => setOpenPass(pass)} />
        ))}
      </section>

      {/* ────── Executive narrative ────── */}
      <NarrativeParagraph study={study} />

      {/* ────── Decision tools ────── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QualityCostGrid passes={study.passes} />
        <CostAtScaleSlider passes={study.passes} />
      </section>

      <IndustryBenchmark passes={study.passes} />

      <VerifiedByBadges study={study} />

      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Cost by SDLC phase, all passes</h2>
        <p className="text-sm text-slate-500 mb-4">
          Premium-judgment phases stay on Opus across all passes — only the cost-efficient phases differ.
        </p>
        <div className="h-80">
          <ResponsiveContainer>
            <BarChart data={buildPhaseChartData(study.passes)}>
              <XAxis dataKey="phase" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => `$${v.toFixed(4)}`} />
              <Legend />
              {study.passes.map((p, i) => (
                <Bar
                  key={p.config.id}
                  dataKey={p.config.id}
                  name={p.config.shortLabel}
                  fill={["#7c3aed", "#2563eb", "#0891b2"][i] ?? "#94a3b8"}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold mb-3">Quality scores per pass</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200">
                <th className="py-2 pr-3">Pass</th>
                <th className="py-2 pr-3">Correctness</th>
                <th className="py-2 pr-3">Test coverage</th>
                <th className="py-2 pr-3">Security</th>
                <th className="py-2 pr-3">Documentation</th>
                <th className="py-2 pr-3">Code style</th>
                <th className="py-2 pr-3">Build / tests</th>
              </tr>
            </thead>
            <tbody>
              {study.passes.map((p) => {
                const q = p.manifest.quality_scores ?? {};
                const a = p.manifest.artifacts ?? {};
                const passed = a.tests_passed ?? "—";
                const total = a.tests ?? "—";
                return (
                  <tr key={p.config.id} className="border-b border-slate-100">
                    <td className="py-2 pr-3 font-medium">{p.config.shortLabel}</td>
                    {(["correctness", "test_coverage", "security_posture", "documentation", "code_style"] as const).map((k) => (
                      <td key={k} className="py-2 pr-3 font-mono">{q[k] ? Number(q[k]).toFixed(2) : "—"}</td>
                    ))}
                    <td className="py-2 pr-3 text-xs">
                      {a.build_ok === true ? <span className="pill bg-emerald-100 text-emerald-800">build ✓</span>
                       : a.build_ok === false ? <span className="pill bg-rose-100 text-rose-800">build ✗</span>
                       : <span className="pill bg-slate-100 text-slate-600">—</span>}
                      <span className="ml-1">{passed}/{total} tests</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-center text-xs text-slate-400">
        Tip: click any pass card above to see its routing policy. Print this view (⌘P) for board decks.
      </p>

      {openPass && (
        <Modal open={true} onClose={() => setOpenPass(null)} title={`${openPass.config.label} — policy`}>
          <PolicyDetail policy={data.policies[openPass.config.policy]} />
        </Modal>
      )}
    </div>
  );
}

function PassCard({ pass, baselineCost, onClick }: { pass: PassData; baselineCost: number; onClick: () => void }) {
  const m = pass.manifest;
  const a = m.artifacts ?? {};
  // GATE — three states:
  //   verified:           authoring succeeded AND code compiles AND tests pass
  //                       (Phase 1 standard; Track B target for Yotsuba)
  //   authored:           authoring succeeded (no envelope leaks) but code does
  //                       not yet compile cleanly. We DO show cost numbers here
  //                       because the cost is a faithful measurement of what
  //                       the authoring run actually spent; the compile-clean
  //                       refinement is a separate Track B story. The card
  //                       flags ts_errors prominently.
  //   pending:            authoring hasn't run, or envelope leaks were detected
  //                       (= the pipeline itself failed, so cost numbers can't
  //                       be trusted).
  const hasCost = (m.total_cost_usd ?? 0) > 0;
  const buildOk = a.build_ok === true;
  const testsPassed = (a.tests_passed ?? 0) > 0;
  const envelopeLeaks = (a as any).envelope_leaks ?? 0;
  const buildAttempted = a.build_ok !== undefined;
  const pipelineOk = hasCost && envelopeLeaks === 0;
  const verified = pipelineOk && buildOk && testsPassed;
  const authored = pipelineOk && !verified && buildAttempted;

  const total = m.total_cost_usd ?? 0;
  const isBaseline = pass.config.id === "pass1";
  const savedPct = baselineCost > 0 && !isBaseline && total > 0 ? ((1 - total / baselineCost) * 100) : 0;
  const headerCls = HEADER_BG[pass.config.headerColor] ?? "bg-slate-700 text-white";
  const models = Object.entries(m.model_breakdown ?? {}).sort((a, b) => b[1].cost_usd - a[1].cost_usd);

  return (
    // No colored border — relies on shadow + colored header. Avoids the
    // 1px gap between page bg and header that caused Pass 1's "top doesn't
    // fill" issue.
    <button
      onClick={onClick}
      className="text-left bg-white rounded-2xl shadow-sm hover:shadow-md transition overflow-hidden group ring-1 ring-slate-200"
    >
      <div className={`${headerCls} px-5 py-3`}>
        <div className="text-xs uppercase tracking-wider opacity-90">{pass.config.shortLabel}</div>
        <div className="font-bold text-lg mt-0.5">{pass.config.label}</div>
      </div>
      <div className="p-5 space-y-3">
        {verified ? (
          <div className="flex items-baseline gap-3">
            <div className="text-3xl font-bold text-ink">${total.toFixed(4)}</div>
            {!isBaseline && (
              <div className={`text-sm font-semibold ${savedPct > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                {savedPct > 0 ? `−${savedPct.toFixed(1)}%` : `+${Math.abs(savedPct).toFixed(1)}%`} vs baseline
              </div>
            )}
            <span className="ml-auto pill bg-emerald-100 text-emerald-800">✓ verified</span>
          </div>
        ) : authored ? (
          // Track A state: authoring pipeline succeeded; cost numbers are real
          // and validated, but ts_errors > 0 means the code needs refinement
          // (Track B). We DISPLAY the cost so the comparison story is told.
          <div>
            <div className="flex items-baseline gap-3">
              <div className="text-3xl font-bold text-ink">${total.toFixed(total < 1 ? 4 : 2)}</div>
              {!isBaseline && baselineCost > 0 && (
                <div className={`text-sm font-semibold ${savedPct > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {savedPct > 0 ? `−${savedPct.toFixed(1)}%` : `+${Math.abs(savedPct).toFixed(1)}%`} vs baseline
                </div>
              )}
              <span className="ml-auto pill bg-amber-100 text-amber-800">⚠ authored, refinement pending</span>
            </div>
            <div className="mt-1.5 text-xs text-slate-600">
              {(a.ts_errors ?? 0) > 0 && <span className="font-mono">{a.ts_errors} TS errors</span>}
              {(a.ts_errors ?? 0) > 0 && (a.files ?? 0) > 0 && <span> · </span>}
              {(a.files ?? 0) > 0 && <span>{a.files} files / {(a.loc ?? 0).toLocaleString()} LOC</span>}
            </div>
            <div className="mt-1 text-xs text-slate-500 italic">
              Single-shot author-from-scratch — refinement-packet loops deferred to Track B. Cost numbers reflect actual API spend; compile-clean is Track B's improvement story.
            </div>
          </div>
        ) : buildAttempted && !buildOk && !pipelineOk ? (
          // Hard failure: envelope leaks → authoring pipeline itself failed.
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="pill bg-rose-100 text-rose-800">✗ Pipeline failed</span>
              {envelopeLeaks > 0 && (
                <span className="text-xs text-rose-600 font-medium">{envelopeLeaks} envelope leaks</span>
              )}
            </div>
            <div className="text-sm text-slate-500">
              The authoring pipeline produced corrupt files (JSON envelope leakage). Cost numbers withheld until the pipeline is fixed and the pass is re-run.
            </div>
          </div>
        ) : (
          <div>
            <div className="pill bg-slate-200 text-slate-700 mb-1">Awaiting authoring run</div>
            <div className="text-sm text-slate-500">
              No telemetry yet. Cost numbers will appear here once the authoring pipeline runs and the verifier processes the manifest.
            </div>
          </div>
        )}

        <div className="text-xs text-slate-500">{pass.config.description}</div>

        {verified && (
          <>
            <div className="border-t border-slate-100 pt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="uppercase tracking-wider text-slate-500 font-medium mb-0.5">Total duration</div>
                <div className="text-base font-semibold text-ink">{formatDuration(m.duration_sec)}</div>
              </div>
              <div>
                <div className="uppercase tracking-wider text-slate-500 font-medium mb-0.5">LLM calls</div>
                <div className="text-base font-semibold text-ink">
                  {Object.values(m.model_breakdown ?? {}).reduce((acc: number, x: any) => acc + (x.calls ?? 0), 0)}
                </div>
              </div>
            </div>
            <div className="border-t border-slate-100 pt-3">
              <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-2">Calls + cost by model</div>
              <div className="space-y-1.5">
                {models.length === 0 ? (
                  <div className="text-xs text-slate-400">(no telemetry yet)</div>
                ) : models.map(([name, v]) => (
                  <div key={name} className="flex items-center gap-2 text-sm">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: MODEL_COLORS[name] ?? "#94a3b8" }} />
                    <span className="font-mono text-xs flex-1 truncate">{name}</span>
                    <span className="text-slate-500 text-xs">{v.calls} calls</span>
                    <span className="font-mono text-xs font-semibold">${v.cost_usd.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="border-t border-slate-100 pt-3 text-xs text-slate-500">
          Policy: <span className="font-mono">{pass.config.policy}</span>
          <span className="float-right text-brand-700 group-hover:underline">View policy →</span>
        </div>
      </div>
    </button>
  );
}

function buildPhaseChartData(passes: PassData[]) {
  const phases = new Set<string>();
  for (const p of passes) {
    for (const k of Object.keys(p.manifest.phase_breakdown ?? {})) phases.add(k);
  }
  return Array.from(phases).map((phase) => {
    const row: any = { phase: prettyPhase(phase) };
    for (const p of passes) {
      row[p.config.id] = +((p.manifest.phase_breakdown?.[phase]?.cost_usd) ?? 0).toFixed(4);
    }
    return row;
  }).sort((a, b) => (b.pass1 ?? 0) - (a.pass1 ?? 0));
}

function prettyPhase(p: string): string {
  return p.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
