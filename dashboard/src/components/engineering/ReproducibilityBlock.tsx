import React from "react";
import type { PassData } from "../../lib/types";

/**
 * Reproducibility block — git tag, brief SHA-256, policy SHA-256, model IDs
 * run-day, run timestamp. A single screen-capture proves a specific run is
 * reproducible.
 *
 * Renders gracefully when reproducibility fields are missing (e.g. Phase 1
 * data predates this instrumentation).
 */
export function ReproducibilityBlock({ pass, repoUrl }: { pass: PassData; repoUrl?: string }) {
  const r = pass.manifest.reproducibility ?? {};
  const fields: Array<{ label: string; value: string | undefined; mono?: boolean }> = [
    { label: "Pass",          value: pass.config.label },
    { label: "Policy",        value: pass.config.policy, mono: true },
    { label: "Git tag",       value: r.git_tag, mono: true },
    { label: "Git SHA",       value: r.git_sha ? r.git_sha.slice(0, 12) : undefined, mono: true },
    { label: "Run started",   value: r.run_started_at ?? pass.manifest.started_at },
    { label: "Run ended",     value: pass.manifest.ended_at },
    { label: "Brief SHA-256", value: r.brief_sha256 ? r.brief_sha256.slice(0, 16) + "…" : undefined, mono: true },
    { label: "Design SHA-256", value: r.design_sha256 ? r.design_sha256.slice(0, 16) + "…" : undefined, mono: true },
    { label: "Policy SHA-256", value: r.policy_sha256 ? r.policy_sha256.slice(0, 16) + "…" : undefined, mono: true },
  ];

  const present = fields.filter((f) => f.value);

  return (
    <section className="card">
      <h2 className="text-lg font-semibold mb-1">Reproducibility</h2>
      <p className="text-sm text-slate-500 mb-4">
        Pinned identifiers that let an independent reviewer re-run this exact configuration.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {present.map((f) => (
          <div key={f.label} className="flex items-start gap-3">
            <div className="text-slate-500 w-32 flex-shrink-0">{f.label}</div>
            <div className={f.mono ? "font-mono text-xs break-all" : "text-slate-800"}>{f.value}</div>
          </div>
        ))}
      </div>

      {r.model_ids && Object.keys(r.model_ids).length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-200">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
            Model IDs at run time
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(r.model_ids).map(([display, actual]) => (
              <div key={display} className="flex items-center gap-3">
                <span className="font-mono text-xs text-slate-600 w-40">{display}</span>
                <span className="text-slate-400">→</span>
                <span className="font-mono text-xs text-slate-800">{actual}</span>
                {display !== actual && (
                  <span className="pill bg-amber-100 text-amber-800 text-[10px] ml-2">substituted</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {repoUrl && (
        <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500">
          Full repo:{" "}
          <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="text-violet-700 hover:underline font-mono">
            {repoUrl}
          </a>
          {r.git_tag && (
            <>
              {"  "}·{"  "}
              <a
                href={`${repoUrl}/releases/tag/${r.git_tag}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-700 hover:underline font-mono"
              >
                releases/tag/{r.git_tag}
              </a>
            </>
          )}
        </div>
      )}

      {present.length <= 3 && (
        <div className="mt-3 text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded border border-amber-200">
          ⚠ Some reproducibility fields are missing. They'll populate automatically once Phase 2's <code>run-pass.mjs</code> writes them.
        </div>
      )}
    </section>
  );
}
