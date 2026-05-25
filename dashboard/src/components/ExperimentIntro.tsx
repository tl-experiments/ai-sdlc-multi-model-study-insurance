import React, { useState } from "react";

/**
 * Brief experiment overview for first-time viewers. Collapsible so it stays
 * out of the way after the reader has read it once.
 *
 * Styled to match the Policy Builder intro card (light blue/indigo gradient
 * + slate text) so the dashboard reads as one consistent palette.
 */
export function ExperimentIntro() {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-xs uppercase tracking-wider text-blue-700 font-semibold">About this study</div>
          <h2 className="text-xl font-bold mt-1 text-slate-900">Multi-Model SDLC Orchestration</h2>
          {expanded ? (
            <div className="mt-3 space-y-2 text-sm text-slate-700 leading-relaxed">
              <p>
                We ran <strong>the same product brief</strong> — a NestJS + React workforce-operations
                service with PII encryption, RBAC, and audit logging — through three identical SDLC
                pipelines, each with a different routing policy:
              </p>
              <ol className="list-decimal list-inside space-y-1 pl-2">
                <li><strong>Pass 1</strong> — every phase on Claude Opus 4.7 (the premium ceiling).</li>
                <li><strong>Pass 2</strong> — premium-judgment phases on Opus 4.7, mechanical work on Gemini 3.1 Pro.</li>
                <li><strong>Pass 3</strong> — premium-judgment phases on Opus 4.7, mechanical work on Gemini 3.5 Flash.</li>
              </ol>
              <p>
                Each pass produced a complete, independently-runnable codebase. We then measured
                the <strong>actual model spend</strong>, the <strong>real-world quality signals</strong> (build, test pass rate),
                and the <strong>per-phase + per-model breakdown</strong> so the cost gains can be defended
                to both a CFO and a code reviewer.
              </p>
              <div className="mt-2 pt-3 border-t border-blue-200/70">
                <div className="text-xs uppercase tracking-wider text-blue-700 font-semibold mb-1">How we built it</div>
                <p>
                  We used <strong>Claude Code</strong> as the host CLI, taking a <strong>least-disruption approach</strong> —
                  no fork, no wrapper. The orchestration ships as a small <strong>Claude Code plugin suite</strong> that
                  seamlessly delegates the cost-efficient phases to <strong>Gemini</strong> via a bundled MCP server.
                  The same architecture is <strong>portable to Gemini CLI and ChatGPT Codex</strong>: both speak MCP,
                  so the same plugin (or a thin equivalent) drops in unchanged.
                </p>
              </div>
              <p className="text-slate-600 text-xs">
                Click any pass card to see its full routing policy. Open the Engineering view for per-call audit,
                rule-firing heatmap, side-by-side policy comparison. Open the Policy Builder to draft your own.
              </p>
            </div>
          ) : (
            <div className="mt-1 text-sm text-slate-600">Same brief, three policies, three full builds — quality verified.</div>
          )}
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs px-3 py-1.5 rounded-md bg-white border border-blue-300 hover:bg-blue-100 text-blue-800 transition shrink-0"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
    </section>
  );
}
