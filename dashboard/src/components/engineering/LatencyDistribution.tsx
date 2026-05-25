import React from "react";
import type { TelemetryEvent } from "../../lib/types";

/**
 * Latency p50 / p95 per (phase, model), computed from filtered telemetry.
 * Quality story isn't just correctness; latency matters operationally.
 */
export function LatencyDistribution({ events }: { events: TelemetryEvent[] }) {
  if (events.length === 0) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Latency p50 / p95</h2>
        <p className="text-sm text-slate-500">No telemetry events in the current filter.</p>
      </section>
    );
  }

  const groups = new Map<string, { phase: string; model: string; samples: number[] }>();
  for (const e of events) {
    const k = `${e.phase}__${e.model}`;
    const g = groups.get(k) ?? { phase: e.phase, model: e.model, samples: [] };
    if (typeof e.latency_ms === "number" && e.latency_ms > 0) g.samples.push(e.latency_ms);
    groups.set(k, g);
  }

  const rows = Array.from(groups.values())
    .filter((g) => g.samples.length > 0)
    .map((g) => {
      const sorted = g.samples.slice().sort((a, b) => a - b);
      return {
        phase: g.phase,
        model: g.model,
        n: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted[sorted.length - 1],
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      };
    })
    .sort((a, b) => b.p95 - a.p95);

  const maxP95 = rows.length > 0 ? rows[0].p95 : 1;

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Latency p50 / p95, by phase × model</h2>
      <p className="text-sm text-slate-500 mb-3">
        Median and tail latency per call. The bar shows p95 relative to the slowest group.
      </p>
      <div className="overflow-x-auto max-h-96">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="text-left border-b border-slate-200">
              <th className="py-2 pr-3">Phase</th>
              <th className="py-2 pr-3">Model</th>
              <th className="py-2 pr-3 text-right">n</th>
              <th className="py-2 pr-3 text-right">p50</th>
              <th className="py-2 pr-3 text-right">p95</th>
              <th className="py-2 pr-3 text-right">max</th>
              <th className="py-2 pr-3 w-48">p95 visualization</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.phase}-${r.model}`} className="border-b border-slate-100">
                <td className="py-1.5 pr-3">{r.phase}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.model}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs">{r.n}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs">{fmtMs(r.p50)}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs font-bold">{fmtMs(r.p95)}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-xs text-slate-500">{fmtMs(r.max)}</td>
                <td className="py-1.5 pr-3">
                  <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${Math.min(100, (r.p95 / maxP95) * 100)}%`,
                        background: r.p95 > 30_000 ? "#ef4444" : r.p95 > 10_000 ? "#f59e0b" : "#10b981",
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[idx];
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
