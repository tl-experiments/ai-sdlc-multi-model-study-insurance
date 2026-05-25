import React from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { TelemetryEvent } from "../../lib/types";

/**
 * Retry distribution histogram by phase × model. Honest signal of how often
 * each model needed escalation. Buckets: 0 (first-try success), 1, 2+.
 */
export function RetryHistogram({ events }: { events: TelemetryEvent[] }) {
  if (events.length === 0) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Retry distribution</h2>
        <p className="text-sm text-slate-500">No telemetry events in the current filter.</p>
      </section>
    );
  }

  // Bucket per (phase, model)
  const bucket = (n: number) => (n === 0 ? "0" : n === 1 ? "1" : "2+");
  const groups = new Map<string, { phase: string; model: string; "0": number; "1": number; "2+": number; total: number }>();
  for (const e of events) {
    const k = `${e.phase}__${e.model}`;
    const g = groups.get(k) ?? { phase: e.phase, model: e.model, "0": 0, "1": 0, "2+": 0, total: 0 };
    const b = bucket(e.retry_count ?? 0);
    g[b]++;
    g.total++;
    groups.set(k, g);
  }
  const data = Array.from(groups.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);   // top 12 most-active groups

  // Stacked-bar shape
  const chartData = data.map((g) => ({
    label: `${g.phase} · ${shortModel(g.model)}`,
    "First-try":  g["0"],
    "1 retry":    g["1"],
    "2+ retries": g["2+"],
    phase: g.phase, model: g.model,
  }));

  // Top-level "% first-try success" line
  const totalFirstTry = data.reduce((a, b) => a + b["0"], 0);
  const grandTotal = data.reduce((a, b) => a + b.total, 0);
  const firstTryPct = grandTotal > 0 ? Math.round((totalFirstTry / grandTotal) * 100) : 0;

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Retry distribution, by phase × model</h2>
      <p className="text-sm text-slate-500 mb-3">
        Across <span className="font-mono">{grandTotal}</span> calls:{" "}
        <span className="font-mono font-semibold">{firstTryPct}%</span> succeeded on first try.
      </p>
      <div className="h-72">
        <ResponsiveContainer>
          <BarChart data={chartData} layout="vertical" margin={{ left: 80, right: 24, top: 8, bottom: 8 }}>
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={220} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d: any = payload[0].payload;
                return (
                  <div className="bg-white shadow-md border border-slate-200 rounded-lg px-3 py-2 text-xs">
                    <div className="font-semibold text-slate-800">{d.phase}</div>
                    <div className="font-mono text-slate-500">{d.model}</div>
                    <div className="mt-1 text-slate-700">First-try: <span className="font-mono">{d["First-try"]}</span></div>
                    <div className="text-slate-700">1 retry: <span className="font-mono">{d["1 retry"]}</span></div>
                    <div className="text-slate-700">2+ retries: <span className="font-mono">{d["2+ retries"]}</span></div>
                  </div>
                );
              }}
            />
            <Bar dataKey="First-try" stackId="r" fill="#10b981" />
            <Bar dataKey="1 retry" stackId="r" fill="#f59e0b" />
            <Bar dataKey="2+ retries" stackId="r" fill="#ef4444" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> First-try success</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-amber-500" /> 1 retry</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm bg-red-500" /> 2+ retries (escalation)</span>
      </div>
    </section>
  );
}

function shortModel(m: string): string {
  if (m.startsWith("claude-")) return m.split("-").slice(1, 4).join("-");
  return m;
}
