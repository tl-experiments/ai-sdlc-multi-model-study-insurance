import React from "react";
import { Link } from "react-router-dom";
import type { LoadedData } from "../lib/loadTelemetry";
import type { StudyData } from "../lib/types";
import { pipelineOk } from "../lib/passGate";

/**
 * The portfolio of case studies. First card a visitor sees after the
 * Tilicho header. Each card opens one study's detail (exec/eng/builder).
 *
 * Phase 1's "Workforce Ops" lives here as Case Study #1 — its data is
 * untouched and accessible via this card. Phase 2 adds "Yotsuba Claims"
 * alongside; future studies are one studies.json entry away.
 */
export function CaseStudyLanding({ data }: { data: LoadedData }) {
  return (
    <div className="space-y-6">
      <section className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-6 shadow-sm">
        <div className="text-xs uppercase tracking-wider text-blue-700 font-semibold">Independent Study by Tilicho Labs</div>
        <h1 className="text-2xl font-bold mt-1 text-slate-900">Multi-Model SDLC Orchestration — Case Study Portfolio</h1>
        <p className="text-sm text-slate-700 mt-2 leading-relaxed">
          We run the same product brief through identical SDLC pipelines using different model-routing policies,
          then measure the actual model spend, real-world quality signals (build, tests), and per-phase + per-model breakdown.
          Each study below is independently reproducible from a public repo. Click any card to drill in.
        </p>
        <div className="mt-3 pt-3 border-t border-blue-200/70">
          <div className="text-xs uppercase tracking-wider text-blue-700 font-semibold mb-1">How we built it</div>
          <p className="text-sm text-slate-700 leading-relaxed">
            <strong>Claude Code</strong> hosts the orchestration via a small <strong>plugin suite</strong> that
            delegates cost-efficient phases to <strong>Gemini</strong> through a bundled MCP server.
            The same architecture is portable to Gemini CLI and ChatGPT Codex.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {data.studies.map((study) => (
          <StudyCard key={study.config.id} study={study} />
        ))}
      </section>
    </div>
  );
}

const HEADER_BG: Record<string, string> = {
  violet: "bg-violet-600 text-white",
  blue: "bg-blue-600 text-white",
  cyan: "bg-cyan-600 text-white",
  rose: "bg-rose-600 text-white",
  amber: "bg-amber-600 text-white",
  indigo: "bg-indigo-600 text-white",
  slate: "bg-slate-700 text-white",
};

function StudyCard({ study }: { study: StudyData }) {
  const headerCls = HEADER_BG[study.config.headerColor] ?? HEADER_BG.slate;
  const verified = study.passes.filter(pipelineOk);
  const baselinePass = study.passes[0];
  const baselineCost = baselinePass?.manifest?.total_cost_usd ?? 0;
  const bestPass = [...study.passes]
    .filter((p) => (p.manifest?.total_cost_usd ?? 0) > 0)
    .sort((a, b) => (a.manifest.total_cost_usd ?? 0) - (b.manifest.total_cost_usd ?? 0))[0];
  const bestCost = bestPass?.manifest?.total_cost_usd ?? 0;
  const savedPct = baselineCost > 0 && bestCost > 0 && bestPass?.config.id !== baselinePass.config.id
    ? ((1 - bestCost / baselineCost) * 100)
    : 0;

  // "Pending" state: no pass has cost data yet. Render an explicit "study
  // staged, awaiting Pass 1" panel instead of a row of em-dashes that looks
  // like the data failed to load.
  const isPending = verified.length === 0 && baselineCost === 0;
  // Heuristic: assume a pass partially ran if its telemetry has events.
  const inProgressPass = study.passes.find(
    (p) => (p.events?.length ?? 0) > 0 && (p.manifest?.total_cost_usd ?? 0) === 0,
  );

  return (
    <Link
      to={`/${study.config.id}/exec`}
      className="block bg-white rounded-2xl shadow-sm hover:shadow-md transition overflow-hidden ring-1 ring-slate-200 group"
    >
      <div className={`${headerCls} px-5 py-4`}>
        <div className="text-xs uppercase tracking-wider opacity-90 flex items-center justify-between">
          <span>{study.config.phase} · {study.config.vertical}</span>
          {isPending && (
            <span className="bg-white/20 text-white text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider font-semibold">
              Staged — awaiting Pass 1
            </span>
          )}
        </div>
        <div className="font-bold text-lg mt-0.5">{study.config.label}</div>
      </div>
      <div className="p-5 space-y-3">
        <p className="text-sm text-slate-700">{study.config.description}</p>

        {isPending ? (
          <PendingPanel study={study} inProgressPass={inProgressPass} />
        ) : (
          <div className="grid grid-cols-3 gap-3 pt-3 border-t border-slate-100">
            <Stat label="Passes" value={`${verified.length}/${study.passes.length}`} sub="verified" />
            <Stat
              label="Baseline cost"
              value={baselineCost > 0 ? `$${baselineCost.toFixed(2)}` : "—"}
              sub={baselinePass?.config.shortLabel ?? ""}
            />
            <Stat
              label="Best savings"
              value={savedPct > 0 ? `−${savedPct.toFixed(1)}%` : "—"}
              sub={bestPass?.config.shortLabel ?? ""}
              tone={savedPct > 0 ? "positive" : "neutral"}
            />
          </div>
        )}

        <div className="text-xs text-slate-500 pt-2">
          <span className="text-brand-700 group-hover:underline">
            {isPending ? "View study scaffolding →" : "View study →"}
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Explicit "pending" panel for a study card. Shown when no pass has cost
 * data — communicates "deliberately scaffolded, awaiting authoring run"
 * rather than the broken-looking "—" row of stats.
 */
function PendingPanel({
  study, inProgressPass,
}: { study: StudyData; inProgressPass: import("../lib/types").PassData | undefined }) {
  // baseline_cost_usd in studies.json is the expected/target spend
  const expectedBaseline = study.config.baseline_cost_usd;
  return (
    <div className="pt-3 border-t border-slate-100 space-y-3">
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
        <span className="text-base leading-none">⏳</span>
        <div>
          <div className="font-semibold mb-0.5">Study scaffolding is live — authoring run pending</div>
          {inProgressPass
            ? (
              <div>
                <span className="font-mono text-[11px]">{inProgressPass.config.shortLabel}</span>{" "}
                is mid-run ({inProgressPass.events.length} events recorded).
                Cost numbers will appear once it completes and the verifier confirms build + tests pass.
              </div>
            ) : (
              <div>
                Brief, design, policies, and the orchestration pipeline are all in place.
                Cost numbers will appear once Pass 1 authors the codebase and the verifier confirms build + tests pass.
              </div>
            )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Planned passes</div>
          <div className="text-lg font-bold text-slate-700">{study.passes.length}</div>
          <div className="text-[10px] text-slate-400 truncate">{study.passes.map((p) => p.config.shortLabel).join(" · ")}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Target baseline</div>
          <div className="text-lg font-bold text-slate-700">{expectedBaseline ? `~$${expectedBaseline.toFixed(0)}` : "TBD"}</div>
          <div className="text-[10px] text-slate-400 truncate">Opus 4.7 (estimated)</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">Vertical</div>
          <div className="text-lg font-bold text-slate-700 capitalize">{study.config.vertical}</div>
          <div className="text-[10px] text-slate-400 truncate">{study.passes[0]?.config.shortLabel}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "positive" | "neutral" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">{label}</div>
      <div className={`text-lg font-bold ${tone === "positive" ? "text-emerald-600" : "text-ink"}`}>{value}</div>
      <div className="text-[10px] text-slate-400 truncate">{sub}</div>
    </div>
  );
}
