import React from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, Cell,
} from "recharts";
import type { PassData } from "../../lib/types";

/**
 * 2-D scatter: X = cost (log-friendly linear OK here), Y = quality score (1-5).
 * Each pass is a labeled dot. The "sweet spot" quadrant (low cost, high quality)
 * is shaded. Universally legible "what trade-off am I making?" picture.
 *
 * If <2 passes have quality scores, falls back to a "pending" placeholder so
 * CXO never sees a broken-looking empty chart.
 */
export function QualityCostGrid({ passes }: { passes: PassData[] }) {
  const points = passes
    .map((p) => {
      const cost = p.manifest.total_cost_usd ?? 0;
      const quality = avgQuality(p.manifest.quality_scores);
      const verified =
        cost > 0 &&
        p.manifest.artifacts?.build_ok === true &&
        (p.manifest.artifacts?.tests_passed ?? 0) > 0;
      return { id: p.config.id, label: p.config.shortLabel, cost, quality, verified };
    })
    .filter((d) => d.cost > 0 && d.quality !== null) as Array<{
      id: string; label: string; cost: number; quality: number; verified: boolean;
    }>;

  if (points.length < 2) {
    return (
      <section className="card">
        <h2 className="text-lg font-semibold mb-1">Quality × Cost trade-off</h2>
        <p className="text-sm text-slate-500">
          Needs ≥2 verified passes with quality scores. Currently {points.length}.
        </p>
      </section>
    );
  }

  const maxCost = Math.max(...points.map((p) => p.cost)) * 1.15;
  const colors = ["#7c3aed", "#2563eb", "#0891b2", "#10b981", "#f59e0b"];

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Quality × Cost trade-off</h2>
      <p className="text-sm text-slate-500 mb-3">
        Each pass plotted by spend (X) vs. average quality score (Y). The shaded
        green quadrant is the "sweet spot": low cost <em>and</em> high quality.
      </p>
      <div className="h-72">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 24, bottom: 16, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            {/* Sweet-spot quadrant — bottom-left in cost terms is bottom-right of plot */}
            <ReferenceArea
              x1={0} x2={maxCost / 2}
              y1={4} y2={5}
              fill="#86efac" fillOpacity={0.18}
              stroke="#22c55e" strokeOpacity={0.35} strokeDasharray="4 4"
              ifOverflow="extendDomain"
              label={{ value: "Sweet spot", position: "insideTopLeft", fill: "#166534", fontSize: 11 }}
            />
            <XAxis
              type="number" dataKey="cost" name="Cost"
              domain={[0, maxCost]}
              tickFormatter={(v) => `$${Number(v).toFixed(v < 1 ? 2 : 0)}`}
              tick={{ fontSize: 11 }}
              label={{ value: "Cost (USD)", position: "insideBottom", offset: -4, fontSize: 11, fill: "#64748b" }}
            />
            <YAxis
              type="number" dataKey="quality" name="Quality"
              domain={[1, 5]}
              tick={{ fontSize: 11 }}
              label={{ value: "Quality (1–5)", angle: -90, position: "insideLeft", fontSize: 11, fill: "#64748b" }}
            />
            <ZAxis range={[200, 200]} />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white shadow-md border border-slate-200 rounded-lg px-3 py-2 text-xs">
                    <div className="font-semibold text-slate-800">{d.label}</div>
                    <div className="text-slate-600">Cost: <span className="font-mono">${d.cost.toFixed(4)}</span></div>
                    <div className="text-slate-600">Quality: <span className="font-mono">{d.quality.toFixed(2)}</span> / 5</div>
                  </div>
                );
              }}
            />
            <Scatter data={points}>
              {points.map((p, i) => (
                <Cell key={p.id} fill={colors[i % colors.length]} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      {/* Inline legend (Recharts doesn't render Scatter labels reliably) */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {points.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: colors[i % colors.length] }} />
            <span className="text-slate-700">{p.label}</span>
            <span className="font-mono text-slate-500">·  ${p.cost.toFixed(2)}  ·  {p.quality.toFixed(2)}/5</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function avgQuality(q?: Record<string, number>): number | null {
  if (!q) return null;
  const vals = Object.values(q).filter((v) => typeof v === "number" && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
