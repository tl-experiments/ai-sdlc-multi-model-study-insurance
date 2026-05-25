import React, { useState } from "react";
import type { TelemetryEvent } from "../../lib/types";

/**
 * Tokens × model × module pivot. Smoking gun for any cost claim:
 * "for the FNOL module, here's exactly which model wrote which tokens at what cost."
 *
 * Built from per-event telemetry so it's always consistent with the per-call
 * audit and the headline cost.
 */
export function TokensByModelPivot({ events }: { events: TelemetryEvent[] }) {
  const [groupBy, setGroupBy] = useState<"module" | "phase" | "task_type">("module");

  if (events.length === 0) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Tokens × cost by {groupBy} × model</h2>
        <p className="text-sm text-slate-500">No telemetry events in the current filter.</p>
      </section>
    );
  }

  // Group by [groupBy, model]
  const keyOf = (e: TelemetryEvent): string =>
    groupBy === "module" ? (e.module || "(no module)")
      : groupBy === "phase" ? e.phase
      : e.task_type;

  const models = Array.from(new Set(events.map((e) => e.model))).sort();
  const dims = Array.from(new Set(events.map(keyOf))).sort();

  type Cell = { calls: number; input: number; cached: number; output: number; cost: number };
  const empty = (): Cell => ({ calls: 0, input: 0, cached: 0, output: 0, cost: 0 });

  const grid: Record<string, Record<string, Cell>> = {};
  for (const d of dims) {
    grid[d] = {};
    for (const m of models) grid[d][m] = empty();
  }
  for (const e of events) {
    const d = keyOf(e);
    const c = grid[d][e.model];
    c.calls++;
    c.input += e.input_tokens || 0;
    c.cached += e.input_tokens_cached || 0;
    c.output += e.output_tokens || 0;
    c.cost += e.cost_usd || 0;
  }

  // Row totals + sort dims by total cost desc
  const rowTotals = dims.map((d) => ({
    d,
    cost: models.reduce((a, m) => a + grid[d][m].cost, 0),
  })).sort((a, b) => b.cost - a.cost);
  const sortedDims = rowTotals.map((r) => r.d);

  const grandTotal = rowTotals.reduce((a, b) => a + b.cost, 0);

  return (
    <section className="card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold">Tokens × cost by {groupBy} × model</h2>
          <p className="text-sm text-slate-500">
            Smoking-gun pivot: every dollar in the headline is attributable to a model × {groupBy}.
            Click cells to drill in.
          </p>
        </div>
        <div className="flex gap-1">
          {(["module", "phase", "task_type"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-3 py-1 text-xs rounded border ${
                groupBy === g
                  ? "bg-ink text-white border-ink"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
              }`}
            >
              by {g}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto max-h-[28rem]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left border-b-2 border-slate-300">
              <th className="py-2 pr-3" rowSpan={2}>{groupBy}</th>
              {models.map((m) => (
                <th key={m} className="py-2 px-3 text-center border-l border-slate-200" colSpan={3}>
                  <div className="font-mono text-[11px] text-slate-700">{m}</div>
                </th>
              ))}
              <th className="py-2 pl-3 text-right border-l border-slate-300" rowSpan={2}>
                Row total
              </th>
            </tr>
            <tr className="text-left border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-500">
              {models.map((m) => (
                <React.Fragment key={m}>
                  <th className="py-1 px-2 border-l border-slate-200 text-right">calls</th>
                  <th className="py-1 px-2 text-right">in / cached / out</th>
                  <th className="py-1 px-2 text-right">cost</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedDims.map((d) => {
              const rowTotal = models.reduce((a, m) => a + grid[d][m].cost, 0);
              return (
                <tr key={d} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-1.5 pr-3 font-medium text-slate-800">{d}</td>
                  {models.map((m) => {
                    const c = grid[d][m];
                    if (c.calls === 0) {
                      return (
                        <React.Fragment key={m}>
                          <td className="py-1.5 px-2 text-right text-slate-300 border-l border-slate-100">—</td>
                          <td className="py-1.5 px-2 text-right text-slate-300">—</td>
                          <td className="py-1.5 px-2 text-right text-slate-300">—</td>
                        </React.Fragment>
                      );
                    }
                    return (
                      <React.Fragment key={m}>
                        <td className="py-1.5 px-2 text-right font-mono border-l border-slate-100">{c.calls}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-slate-600">
                          {fmtTok(c.input)}/{fmtTok(c.cached)}/{fmtTok(c.output)}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold">${c.cost.toFixed(4)}</td>
                      </React.Fragment>
                    );
                  })}
                  <td className="py-1.5 pl-3 text-right font-mono font-bold border-l border-slate-300">
                    ${rowTotal.toFixed(4)}
                  </td>
                </tr>
              );
            })}
            {/* Column totals */}
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
              <td className="py-2 pr-3">Column total</td>
              {models.map((m) => {
                const colCalls = sortedDims.reduce((a, d) => a + grid[d][m].calls, 0);
                const colIn = sortedDims.reduce((a, d) => a + grid[d][m].input, 0);
                const colCached = sortedDims.reduce((a, d) => a + grid[d][m].cached, 0);
                const colOut = sortedDims.reduce((a, d) => a + grid[d][m].output, 0);
                const colCost = sortedDims.reduce((a, d) => a + grid[d][m].cost, 0);
                return (
                  <React.Fragment key={m}>
                    <td className="py-2 px-2 text-right font-mono border-l border-slate-200">{colCalls}</td>
                    <td className="py-2 px-2 text-right font-mono text-slate-600">
                      {fmtTok(colIn)}/{fmtTok(colCached)}/{fmtTok(colOut)}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">${colCost.toFixed(4)}</td>
                  </React.Fragment>
                );
              })}
              <td className="py-2 pl-3 text-right font-mono font-bold border-l border-slate-300">
                ${grandTotal.toFixed(4)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
