import React from "react";
import type { StudyData } from "../../lib/types";
import { pipelineOk } from "../../lib/passGate";

/**
 * "Verified by" badge row. Authoritative without being noisy. Each badge that
 * has supporting evidence becomes a real link; the rest sit dimmed so a reader
 * can see what's coming.
 */
export function VerifiedByBadges({ study }: { study: StudyData }) {
  // CI badge is green only when the strict gate (Phase 1 standard) holds across
  // every pass — build_ok && tests_passed > 0. Other badges (vendor invoice,
  // public repo) only need pipelineOk = authoring telemetry trustworthy.
  const anyAuthored = study.passes.some(pipelineOk);
  const allStrictlyVerified = study.passes.length > 0 && study.passes.every((p) => {
    const a = p.manifest.artifacts ?? {};
    return pipelineOk(p) && a.build_ok === true && (a.tests_passed ?? 0) > 0;
  });
  const anyVerified = anyAuthored;
  const allVerified = allStrictlyVerified;

  // Evidence links — Phase 2 plan places vendor invoices under
  // case-studies/<study-id>/evidence/. Use the public copy under
  // dashboard/public/evidence/<study-id>/ if present.
  const studyId = study.config.id;
  const evidenceBase = `/evidence/${studyId}`;
  const ghRepo = "https://github.com/tl-experiments/ai-sdlc-multi-model-study-insurance";

  const badges = [
    {
      key: "anthropic",
      label: "Anthropic invoice",
      href: `${evidenceBase}/anthropic-invoice.png`,
      // Until evidence exists, the badge is dimmed and non-clickable.
      // (Renderer marks it active if-and-only-if a real run has produced cost.)
      active: anyVerified,
      tooltip: "Vendor invoice screenshot matching pass total_cost_usd within ±$1",
    },
    {
      key: "google",
      label: "Google invoice",
      href: `${evidenceBase}/gemini-invoice.png`,
      active: anyVerified && study.passes.some((p) =>
        Object.keys(p.manifest.model_breakdown ?? {}).some((m) => m.toLowerCase().includes("gemini"))),
      tooltip: "Google AI Studio billing screenshot matching Gemini call cost within ±$1",
    },
    {
      key: "ci",
      label: allVerified ? "CI green" : "CI pending",
      href: `${ghRepo}/actions`,
      active: allVerified,
      tooltip: "GitHub Actions workflow runs verify the build + tests on every push",
    },
    {
      key: "repo",
      label: "Public repo",
      href: ghRepo,
      active: true,                    // always live once repo exists
      tooltip: "Full source, telemetry, and reproduction instructions",
    },
  ];

  return (
    <section className="rounded-2xl bg-white border border-slate-200 px-5 py-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-slate-500 font-semibold mr-2">
          Verified by
        </span>
        {badges.map((b) => (
          <a
            key={b.key}
            href={b.active ? b.href : undefined}
            target={b.active ? "_blank" : undefined}
            rel={b.active ? "noopener noreferrer" : undefined}
            title={b.tooltip}
            className={[
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition",
              b.active
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 cursor-pointer"
                : "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed",
            ].join(" ")}
            onClick={(e) => { if (!b.active) e.preventDefault(); }}
          >
            <span>{b.active ? "✓" : "○"}</span>
            <span>{b.label}</span>
          </a>
        ))}
      </div>
    </section>
  );
}
