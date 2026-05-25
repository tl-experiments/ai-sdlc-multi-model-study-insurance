import React from "react";
import type { Policy } from "../lib/types";
import { parse as parseYaml } from "yaml";

/**
 * Read-only policy viewer — used inside the modal that opens when a pass
 * card is clicked. Renders the policy as a clean table rather than raw YAML.
 */
export function PolicyDetail({ policy, raw }: { policy?: Policy; raw?: string }) {
  if (!policy && raw) {
    try { policy = parseYaml(raw); } catch {}
  }
  if (!policy) return <div className="text-slate-500 text-sm">Policy not loaded.</div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="label">Policy</div>
        <div className="text-lg font-bold mt-1">{policy.name} <span className="text-xs text-slate-400 font-normal">v{policy.version}</span></div>
      </div>

      <div>
        <div className="label mb-2">Models</div>
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium text-slate-600">ID</th>
                <th className="px-3 py-2 font-medium text-slate-600">Model</th>
                <th className="px-3 py-2 font-medium text-slate-600">Adapter</th>
                <th className="px-3 py-2 font-medium text-slate-600 text-right">Input/1M</th>
                <th className="px-3 py-2 font-medium text-slate-600 text-right">Cached/1M</th>
                <th className="px-3 py-2 font-medium text-slate-600 text-right">Output/1M</th>
              </tr>
            </thead>
            <tbody>
              {policy.models.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{m.id}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {m.display_name && m.display_name !== m.model_name ? (
                      <span>
                        <span className="font-medium">{m.display_name}</span>
                        <span className="text-slate-400 ml-1">(via {m.model_name})</span>
                      </span>
                    ) : m.model_name}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{m.adapter}</td>
                  <td className="px-3 py-2 text-right font-mono">${m.pricing.input.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono">${m.pricing.input_cached.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono">${m.pricing.output.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="label mb-2">Routing rules (first match wins)</div>
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium text-slate-600 w-10">#</th>
                <th className="px-3 py-2 font-medium text-slate-600">When</th>
                <th className="px-3 py-2 font-medium text-slate-600">Use model</th>
                <th className="px-3 py-2 font-medium text-slate-600">Reason</th>
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((r, i) => {
                const isDefault = "default" in r;
                return (
                  <tr key={i} className={`border-t border-slate-100 ${isDefault ? "bg-slate-50" : ""}`}>
                    <td className="px-3 py-2 text-xs text-slate-400">{isDefault ? "—" : i + 1}</td>
                    <td className="px-3 py-2 text-xs font-mono text-slate-700">
                      {isDefault ? <span className="italic text-slate-500">default (fallback)</span> : describeMatcher(r.when)}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">{r.use ?? r.default}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.reason ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function describeMatcher(when: any): string {
  if (!when) return "(empty)";
  const parts: string[] = [];
  for (const k of ["phase", "task_type", "module"]) {
    const v = when[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) parts.push(`${k} ∈ [${v.length > 3 ? v.slice(0, 3).join(", ") + ", …" : v.join(", ")}]`);
    else parts.push(`${k} = ${v}`);
  }
  if (when.retry_count) {
    const c = when.retry_count;
    const opMap: any = { lt: "<", lte: "≤", gt: ">", gte: "≥", eq: "=" };
    for (const op of Object.keys(c)) parts.push(`retry_count ${opMap[op] ?? op} ${c[op]}`);
  }
  return parts.join(" · ") || "(any)";
}
