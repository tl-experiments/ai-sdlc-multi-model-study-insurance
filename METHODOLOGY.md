# Methodology

> How we measure cost, quality, and reproducibility in the Multi-Model SDLC Orchestration Study.

This document is written for someone evaluating whether the headline numbers on
[studies.adlc.tilicho.in](https://studies.adlc.tilicho.in) are credible — a
prospective customer's CTO office, an Anthropic-aligned skeptic, Google Cloud
legal, an independent academic reviewer. The goal is to leave no question about
"how was this measured?" unanswered.

---

## 1. What the study compares

For each **case study** (a self-contained software product brief), we run the
**same brief** through several **passes**, each pass using a different model
routing policy. Every pass produces a working codebase end-to-end: source code,
tests, frontend, documentation, ADRs, and a security review.

| Case study | Scope | Passes |
|---|---|---|
| **Workforce Operations Service** (Phase 1 — POC) | HRMS + time tracking with PII protection, RBAC, audit logging | 3 |
| **Japanese P&C Insurer — Claims Processing Platform** (Phase 2) | FNOL intake → adjuster workbench → reserves, with APPI / JFSA / IFRS17 hooks | 5 |

Each pass differs **only** in its model routing policy. The brief, the
architecture reference (`design.md`), the file list, the validation pipeline,
and the human review gates are identical across all passes within a case study.

This is what makes the comparison fair: when Pass 5 (Opus + Gemini Flash) costs
95% less than Pass 1 (Opus-only), the only variable is "which model wrote which
file."

---

## 2. Cost measurement

### 2.1 Source of truth

Cost is computed **per LLM call** from token counts the model API itself
reports, multiplied by the per-million-token price for that model.

```
cost_usd =
    (input_tokens         × input_price_per_million         / 1_000_000)
  + (input_tokens_cached  × input_cached_price_per_million  / 1_000_000)
  + (output_tokens        × output_price_per_million        / 1_000_000)
```

Token counts come from the model response (Anthropic: `usage.input_tokens`,
`usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`,
`usage.output_tokens`; Google: `usageMetadata.promptTokenCount`,
`usageMetadata.cachedContentTokenCount`, `usageMetadata.candidatesTokenCount`).

Prices come from the policy YAML for that pass (see `plugin/config/policies/`).
The policy YAML is part of the run's reproducibility hash, so a price change
forces a re-run.

### 2.2 What we **don't** count

- **Local compute** (running tests, running the verifier, running the
  dashboard locally). These are negligible vs. the API spend and are
  identical across passes, so they cancel out.
- **Embeddings, search, or other API calls** beyond the actual code-authoring
  LLM. The study is scoped to "which LLM authors which file."
- **Human time.** We surface an industry-standard SDE labor cost comparison
  in the Executive view as context, but it is explicitly labeled an estimate.

### 2.3 Vendor invoice cross-check

For each pass, we capture vendor billing screenshots
(`case-studies/<study>/evidence/`) and require the manifest's
`total_cost_usd` to match the invoice within **±$1**. Both numbers are
surfaced on the dashboard.

If they do not match, the run is not published.

### 2.4 What we **do not** claim

> "These prices will hold forever."

API pricing changes. Every manifest pins `policy_sha256` so anyone re-running
the study at a later date can detect and account for price drift.

---

## 3. Quality measurement

Quality is measured along three orthogonal axes, in this order of authority:

### 3.1 Mechanical correctness (the verifier — **objective**)

The single hardest gate: **the codebase must compile and tests must pass.**

For each pass, `tools/verify.mjs`:
1. Runs `npm install` in the pass directory.
2. Runs `tsc --noEmit` (or the equivalent build step). Records
   `build_ok: true | false` and `ts_errors: N`.
3. Runs the generated test suite. Records `tests`, `tests_passed`,
   `tests_failed`, `test_pass_rate`.
4. Counts LOC and module sizes with `cloc`-equivalent logic.

The dashboard **withholds cost numbers** until both `build_ok === true` and
`tests_passed > 0`. A pass with broken code does not get to claim a low cost
number. This is the primary anti-cherry-pick gate.

### 3.2 LLM-as-judge (rubric-based — **interpretable**)

For each pass, `tools/run-judge.mjs` sends every file side-by-side with the
Pass 1 (Opus-only) reference to **Claude Opus** with the rubric in
`judge/rubric.md`. The judge scores each pass on a 1–5 scale across five
categories:

| Category | What it checks |
|---|---|
| `correctness` | Does the code do what the spec says? Edge cases handled? |
| `test_coverage` | Are critical paths tested? Are tests independent? Mocking quality? |
| `security_posture` | Authz applied where expected? Inputs validated? Secrets handled? |
| `documentation` | API docs, ADRs, READMEs present and informative? |
| `code_style` | Idiomatic for the stack? Consistent naming? Comments where needed? |

The judge writes its scores back into each manifest's `quality_scores` block.

**Judge bias caveat (we are transparent about this).** Claude Opus scoring
Opus-written code may be slightly favorable. The bias is partially
symmetric — Opus also wrote the premium-judgment phases of the orchestrated
passes. We document the caveat and (in Track B) plan to add a second judge
(Gemini 2.5 Pro) for cross-validation.

### 3.3 Human spot-check (**holistic**)

We pick a representative controller, service, test file, and ADR from each
pass and eyeball it for "would I land this in production?" judgment. This is
a sanity gate, not a quantitative input. Cases where mechanical correctness +
judge score say "fine" but human review says "smell" are flagged in the
study's `INDEPENDENT_REVIEW.md` (when available).

---

## 4. Reproducibility

The headline of any rigorous study is "can someone else get the same answer
from the same inputs?" We make that explicit:

### 4.1 What's pinned in every manifest

```json
{
  "reproducibility": {
    "git_tag":       "v2.0.0-yotsuba",        // immutable repo state
    "git_sha":       "9f3a2c1...",
    "brief_sha256":  "...",                   // SHA-256 of the brief.md
    "design_sha256": "...",                   // SHA-256 of design.md (Pass 1 output, used as ref)
    "policy_sha256": "...",                   // SHA-256 of the policy YAML
    "run_started_at": "2026-05-26T03:00:00Z",
    "model_ids": {                            // display name → actual API model
      "claude-opus-4-7":   "claude-opus-4-5-20250929",
      "gemini-3-5-flash":  "gemini-3-5-flash"
    }
  }
}
```

A reviewer can:
1. `git checkout <git_tag>` to materialize the exact codebase, brief, design, policies.
2. Diff their re-run's `manifest.json` against the published one.
3. Diff the per-file `artifact_sha256` to see which files matched byte-for-byte.

### 4.2 Substitution badges

Some model names in the policy YAMLs are **label-only** — e.g. the policy says
`claude-opus-4-7` but the API model that actually answers is
`claude-opus-4-5-20250929` because Opus 4.7 hasn't shipped at run time. The
dashboard footer shows a **"Model substitutions in effect"** banner whenever
this is the case, naming the requested-vs-actual mapping. We never silently
substitute.

### 4.3 CI as continuous-reproducibility evidence

`.github/workflows/study.yml` runs the verifier on a small slice
(`--limit=3`) of each pass on every push. If the pipeline ever stops being
re-runnable, CI catches it immediately. This is visible on the
dashboard's "Verified by · CI green" badge.

---

## 5. Forensic telemetry

For each LLM call, we record a single JSON line in `telemetry.jsonl` with:

```json
{
  "ts": "2026-05-26T03:14:22.187Z",
  "pass": "opus-4-7",
  "phase": "codegen",
  "task_type": "controller_handler",
  "task_id": "tp_codegen_017",
  "module": "claims-fnol",
  "model": "claude-opus-4-5-20250929",
  "routed_by": "policy:opus-4-7-with-gemini-3-5-flash",
  "routing": { "policy_name": "...", "policy_version": 1, "rule_index": 6, "rule_reason": "Schema-driven boilerplate — cost-efficient tier" },
  "input_tokens": 4523,
  "input_tokens_cached": 3812,
  "output_tokens": 1207,
  "cost_usd": 0.092,
  "latency_ms": 8743,
  "success": true,
  "retry_count": 0,
  "round_trips": 1,
  "artifact_path": "src/claims-fnol/claims.controller.ts",
  "artifact_loc": 142,
  "artifact_sha256": "..."
}
```

This is the raw substrate for every claim on the dashboard:

| Claim | Telemetry derivation |
|---|---|
| Total cost | `sum(events.cost_usd)` |
| Cost by module × model | `groupby(module, model).sum(cost_usd)` |
| Cache-hit rate | `sum(input_tokens_cached) / sum(input_tokens)`, per group |
| Retry distribution | `groupby(retry_count).count()` |
| Latency p50 / p95 | percentile of `latency_ms`, per group |
| Round-trips per artifact | `groupby(artifact_path).count()` |
| First-try success | `count(retry_count == 0) / count(*)` |

Every dashboard chart is one query away from `telemetry.jsonl`. There is no
secondary aggregate that bypasses the raw data.

---

## 6. What we explicitly do not measure (and why)

| Not measured | Why |
|---|---|
| Streaming TTFB (time-to-first-token) | The orchestrator uses one-shot calls. TTFB is uninformative for batch authoring. |
| Wall-clock for the full SDLC | We surface it as a context number, but it's dominated by network + the human's attention to HITL gates, not by the model itself. |
| Cost of self-hosting | The study is about hosted-API spend. Self-hosting changes the economics and the comparison framing. |
| Cost over multi-month "real product evolution" | The brief is a single vertical-slice authoring exercise. Multi-month maintenance is a different study. |
| Subjective developer-experience preference | LLM choice is a real factor in DX but not part of this cost / quality study. |

If any of these matter to your evaluation, **let us know** — the orchestration
architecture supports running additional measurements as separate passes,
and we publish all data.

---

## 7. Threats to validity (we name them so you don't have to)

1. **Judge bias.** Opus scoring Opus-written code may favor Pass 1. Mitigated
   by partial symmetry (Opus wrote part of every pass) and by planning a
   second-judge cross-validation in Track B.
2. **Cache warm-up.** Prompt caching's 5-min TTL means cost figures are
   sensitive to whether the run is paced quickly enough to keep the cache
   warm. We capture `cache_hit_rate` per pass so the reader can see how this
   played out.
3. **Brief specificity.** A more abstract brief might favor better-judgment
   models more strongly. We mitigate by using domain-realistic briefs
   (Japanese P&C insurance, with regulatory constraints).
4. **Sample of two case studies.** Two domains is not a population. We
   publish per-study results separately and never average across studies to
   make a stronger-than-warranted claim.
5. **Substitution risk.** Where a model name in the policy YAML is a label
   for an unshipped model, the actual model is one tier earlier. This
   under-counts the eventual cost of the labeled model (since newer models
   tend to be priced lower per equivalent quality) and the dashboard surfaces
   the substitution explicitly.

---

## 8. Independent review

A senior engineer not involved in building the study can clone the public
repo, run `npm run study --limit=5` per the [`REPRODUCING.md`](./REPRODUCING.md),
and sign `INDEPENDENT_REVIEW.md` confirming "I observed cost X and test
pass rate Y for pass Z." This is optional but is the strongest single
credibility lift available; when present, the dashboard's "Verified by"
row includes a clickable badge for it.

---

*Maintained by Tilicho Labs. Questions / corrections / objections: open a
GitHub issue on the public repo.*
