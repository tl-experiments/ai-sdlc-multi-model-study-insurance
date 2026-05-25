import React from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { TelemetryEvent } from "../../lib/types";

/**
 * Cache-hit-rate chart, computed per (phase, model) from filtered telemetry.
 * Proves the context-caching strategy is real, not theatrical.
 *
 * Hit rate = sum(input_tokens_cached) / sum(input_tokens).
 * Bar color shifts from amber → emerald as the rate climbs past 0.5.
 */
export function CacheHitChart({ events, title }: { events: TelemetryEvent[]; title?: string }) {
  // Group by phase × model; only include groups that have at least one call.
  const groups = new Map<string, { phase: string; model: string; inputs: number; cached: number; calls: number }>();
  for (const e of events) {
    const k = `${e.phase}__${e.model}`;
    const g = groups.get(k) ?? { phase: e.phase, model: e.model, inputs: 0, cached: 0, calls: 0 };
    g.inputs += e.input_tokens || 0;
    g.cached += e.input_tokens_cached || 0;
    g.calls++;
    groups.set(k, g);
  }
  const data = Array.from(groups.values())
    .filter((g) => g.inputs > 0)
    .map((g) => ({
      label: `${g.phase} · ${shortModel(g.model)}`,
      rate: g.inputs > 0 ? g.cached / g.inputs : 0,
      pct: g.inputs > 0 ? Math.round((g.cached / g.inputs) * 100) : 0,
      calls: g.calls,
      phase: g.phase,
      model: g.model,
    }))
    .sort((a, b) => b.rate - a.rate);

  if (data.length === 0) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">{title ?? "Cache-hit rate, by phase × model"}</h2>
        <p className="text-sm text-slate-500">No telemetry events in the current filter.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">{title ?? "Cache-hit rate, by phase × model"}</h2>
      <p className="text-sm text-slate-500 mb-3">
        Fraction of input tokens served from the prompt cache. Higher = the context-caching strategy is working.
      </p>
      <div className="h-72">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ left: 80, right: 24, top: 8, bottom: 8 }}>
            <XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" tick={{ fontSize: 11 }} width={220} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d: any = payload[0].payload;
                return (
                  <div className="bg-white shadow-md border border-slate-200 rounded-lg px-3 py-2 text-xs">
                    <div className="font-semibold text-slate-800">{d.phase}</div>
                    <div className="font-mono text-slate-500">{d.model}</div>
                    <div className="mt-1 text-slate-700">Cache hit: <span className="font-mono font-bold">{d.pct}%</span></div>
                    <div className="text-slate-500">across <span className="font-mono">{d.calls}</span> calls</div>
                  </div>
                );
              }}
            />
            <Bar dataKey="rate">
              {data.map((d, i) => (
                <Cell key={i} fill={d.rate >= 0.5 ? "#10b981" : d.rate >= 0.2 ? "#f59e0b" : "#ef4444"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function shortModel(m: string): string {
  // claude-opus-4-5-20250929 → opus-4-5
  if (m.startsWith("claude-")) {
    const parts = m.split("-");
    return parts.slice(1, 4).join("-");
  }
  // gemini-3.5-flash → gemini-flash
  return m;
}
