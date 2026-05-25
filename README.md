# Multi-Model SDLC Orchestration — Independent Study

**By [Tilicho Labs](https://tilicho.in).** Live dashboard: **https://studies.adlc.tilicho.in**

This repository hosts the data, code, and reproducibility playbook for an
independent study comparing **five model-routing policies** on real-world
software engineering case studies. The same product brief is run through
identical SDLC pipelines, each using a different model or model-routing
policy, then we measure:

- **actual model spend** (per-call telemetry, cross-checked against vendor invoices),
- **real-world quality signals** (build status, test pass rate, LLM-as-judge rubric scores),
- **per-phase + per-model + per-module attribution** of every dollar spent.

The result is a public, auditable answer to "**which model routing policy
gives me the best cost / quality tradeoff for production software work?**"

## Quick links

| | |
|---|---|
| 📊 **Live dashboard** | https://studies.adlc.tilicho.in |
| 📐 **Methodology** — how cost, quality, reproducibility are measured | [`METHODOLOGY.md`](./METHODOLOGY.md) |
| 🔁 **Reproduce** the study end-to-end | [`REPRODUCING.md`](./REPRODUCING.md) |
| 🗂  **Case Study #1** — Workforce Operations Service (Phase 1 POC) | [`sample-project/`](./sample-project/) |
| 🗂  **Case Study #2** — Japanese P&C Claims Platform (Phase 2 study) | [`case-studies/yotsuba-claims-platform/`](./case-studies/yotsuba-claims-platform/) |
| 🔌 **Multi-model orchestrator plugin** — the Claude Code plugin under study | [`plugin/`](./plugin/) |

## What this study compares

| Pass | Policy | Models used |
|---|---|---|
| 1 | `opus-4-7.yaml` | Claude Opus only (premium baseline) |
| 2 | `sonnet-4-6.yaml` | Claude Sonnet only (pure-Anthropic tier-down) |
| 3 | `haiku-4-5.yaml` | Claude Haiku only (most aggressive Anthropic-only tier-down) |
| 4 | `opus-4-7-with-gemini-3-1-pro.yaml` | Opus for judgment phases + Gemini Pro for mechanical work |
| 5 | `opus-4-7-with-gemini-3-5-flash.yaml` | Opus for judgment + Gemini Flash for the rest (the headline orchestration) |

Each pass produces a complete codebase: source, tests, frontend, docs,
ADRs, security review. All passes are evaluated by the same verifier
(build + tests) and the same LLM-as-judge rubric.

## Why this is credible

This is a study, not a marketing piece. We make that explicit:

- **Every cost number is one query away from `telemetry.jsonl`.** No
  hand-massaged aggregates.
- **No cost number is shown until `build_ok && tests_passed > 0`.** A pass
  with broken code does not get to claim a low cost figure.
- **Vendor invoices are cross-checked** within ±$1 of the published number,
  for every pass, with screenshots in `case-studies/<study>/evidence/`.
- **CI re-runs the verifier on every push** — a one-screenshot proof that
  the study is still re-runnable today.
- **Pinned reproducibility** — every manifest carries `git_tag`,
  `brief_sha256`, `design_sha256`, `policy_sha256`, and the actual
  `model_name` used for each labeled model (substitution badges in the UI
  when a labeled model isn't yet GA).

Threats to validity are named explicitly in
[`METHODOLOGY.md` §7](./METHODOLOGY.md). If you find an issue we missed,
**open a GitHub issue** — the study gets stronger.

## What this study is not

- Not a marketing artifact for any single vendor. The point is the routing
  policy, not the models themselves.
- Not a benchmark of model intelligence in isolation. It's a benchmark of
  **production-grade software authoring under a real cost / quality tradeoff**.
- Not a multi-month evolution study. Each pass is a single authoring run
  against a fixed brief.

## License

MIT. See [`LICENSE`](./LICENSE).

---

*Tilicho Labs — independent AI / agentic software research and integration.
[https://tilicho.in](https://tilicho.in)*
