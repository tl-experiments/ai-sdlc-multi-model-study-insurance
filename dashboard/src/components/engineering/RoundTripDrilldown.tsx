import React, { useState } from "react";
import type { TelemetryEvent } from "../../lib/types";

/**
 * Per-artifact round-trip count, clickable to see the full retry chain. The
 * auditor's holy grail: every retry visible, no cherry-picking.
 *
 * Round trips are the number of LLM events the orchestrator made for one
 * artifact_path. retry_count itself is the per-event counter; total round
 * trips for an artifact = events.length grouped by artifact_path.
 */
export function RoundTripDrilldown({ events }: { events: TelemetryEvent[] }) {
  // Group by artifact_path; track all events for the drilldown.
  const byArtifact = new Map<string, TelemetryEvent[]>();
  for (const e of events) {
    const key = e.artifact_path ?? `(no artifact) — ${e.task_id}`;
    const list = byArtifact.get(key) ?? [];
    list.push(e);
    byArtifact.set(key, list);
  }
  const rows = Array.from(byArtifact.entries())
    .map(([artifact, evs]) => ({
      artifact,
      round_trips: evs.length,
      max_retry: Math.max(...evs.map((e) => e.retry_count ?? 0)),
      total_cost: evs.reduce((a, b) => a + (b.cost_usd ?? 0), 0),
      events: evs.slice().sort((a, b) => (a.retry_count ?? 0) - (b.retry_count ?? 0)),
    }))
    .sort((a, b) => b.round_trips - a.round_trips || b.total_cost - a.total_cost);

  const [expanded, setExpanded] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Round-trips per artifact</h2>
        <p className="text-sm text-slate-500">No telemetry events in the current filter.</p>
      </section>
    );
  }

  // Sort interesting ones to the top: anything with >1 round trip
  const interesting = rows.filter((r) => r.round_trips > 1).slice(0, 50);
  const cleanCount = rows.length - interesting.length;

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Round-trips per artifact</h2>
      <p className="text-sm text-slate-500 mb-3">
        Files that needed more than one LLM call to author. Clean first-try files ({cleanCount}) are collapsed below.
      </p>
      {interesting.length === 0 ? (
        <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-4 py-3 border border-emerald-200">
          ✓ Every artifact was produced in a single round-trip. Refinement-packet rate = 0%.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200">
                <th className="py-2 pr-3">Artifact</th>
                <th className="py-2 pr-3 text-right">Round trips</th>
                <th className="py-2 pr-3 text-right">Max retry</th>
                <th className="py-2 pr-3 text-right">Total cost</th>
                <th className="py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {interesting.map((r) => (
                <React.Fragment key={r.artifact}>
                  <tr
                    className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${
                      expanded === r.artifact ? "bg-slate-50" : ""
                    }`}
                    onClick={() => setExpanded((cur) => (cur === r.artifact ? null : r.artifact))}
                  >
                    <td className="py-1.5 pr-3 font-mono text-xs truncate max-w-md" title={r.artifact}>{r.artifact}</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-bold">{r.round_trips}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{r.max_retry}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">${r.total_cost.toFixed(4)}</td>
                    <td className="py-1.5 text-slate-400 text-center">{expanded === r.artifact ? "▾" : "▸"}</td>
                  </tr>
                  {expanded === r.artifact && (
                    <tr className="border-b border-slate-100 bg-slate-50">
                      <td colSpan={5} className="p-4">
                        <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
                          Full call chain — {r.events.length} events
                        </div>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-slate-500">
                              <th className="py-1 pr-3">#</th>
                              <th className="py-1 pr-3">Retry</th>
                              <th className="py-1 pr-3">Phase</th>
                              <th className="py-1 pr-3">Model</th>
                              <th className="py-1 pr-3 text-right">Tokens (in/cached/out)</th>
                              <th className="py-1 pr-3 text-right">Latency</th>
                              <th className="py-1 pr-3 text-right">Cost</th>
                              <th className="py-1 pr-3">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.events.map((e, i) => (
                              <tr key={`${e.task_id}-${i}`} className="border-t border-slate-200">
                                <td className="py-1 pr-3 font-mono">{i + 1}</td>
                                <td className="py-1 pr-3 font-mono">{e.retry_count}</td>
                                <td className="py-1 pr-3">{e.phase}</td>
                                <td className="py-1 pr-3 font-mono">{e.model}</td>
                                <td className="py-1 pr-3 text-right font-mono">
                                  {e.input_tokens}/{e.input_tokens_cached}/{e.output_tokens}
                                </td>
                                <td className="py-1 pr-3 text-right font-mono">{e.latency_ms} ms</td>
                                <td className="py-1 pr-3 text-right font-mono">${e.cost_usd.toFixed(5)}</td>
                                <td className="py-1 pr-3">
                                  {e.success
                                    ? <span className="pill bg-emerald-100 text-emerald-800">ok</span>
                                    : <span className="pill bg-rose-100 text-rose-800" title={e.error}>fail</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
