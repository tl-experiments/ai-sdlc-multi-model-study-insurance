# Reproducing the Study

> Step-by-step rerun guide. Anyone with API keys for Anthropic + Google AI
> Studio (and a few hours of patience) should be able to reproduce the study
> end-to-end.

The study runs the **same brief** through several **passes**, each using a
different model routing policy, then publishes the cost / quality / telemetry
delta. This guide walks you through doing exactly that on your own
machine. Each step says how much it costs (real money) and how long it
takes.

---

## TL;DR — full re-run cost

| Case study | Approximate API spend | Wall-clock |
|---|---|---|
| Workforce Operations Service (Phase 1, 3 passes) | $4–6 total | 1–2 h |
| Japanese P&C Claims Platform (Phase 2, 5 passes) | $150–200 total | 8–14 h |

You can rerun just one pass to spot-check a single number; full study is not
required to verify the headline claims.

---

## 0. Prerequisites

| Need | Why |
|---|---|
| Node.js ≥ 20 | dashboard build + driver scripts |
| `npm` | dependencies |
| `git` | clone + tag check |
| **Anthropic API key** | Pass 1 / Pass 2 / Pass 3 (Opus, Sonnet, Haiku) and the orchestrated passes' premium-judgment phases |
| **Google AI Studio API key** | orchestrated passes' cost-efficient phases (Gemini Flash / Pro) |
| ~10 GB disk | repo + node_modules per pass + generated artifacts |

**Cost gotcha:** the Anthropic key must have a billing plan that supports
~$100 in spend in a single day for the full Phase 2 study. If you're on a
free / low-tier plan, run with `--limit=5` (below) to do a representative
slice for under $5.

---

## 1. Clone + install

```bash
git clone https://github.com/tl-experiments/ai-sdlc-multi-model-study-insurance.git
cd ai-sdlc-multi-model-study-insurance

# (Optional but recommended) check out the exact tag the dashboard is pinned to.
# The current tag is shown in each manifest's reproducibility.git_tag and on the
# dashboard's Reproducibility block.
git checkout v2.0.0-yotsuba

# Install root + dashboard dependencies
npm install
(cd dashboard && npm install)

# Build the MCP server (compiles TypeScript adapters used by the drivers)
(cd plugin/mcp/gemini-flash-server && npm install && npm run build)
```

---

## 2. Set API keys

Copy the template, fill in your keys, and source it. **Never commit `.env`.**

```bash
cp .env.example .env
# Edit .env in your editor and fill in:
#   ANTHROPIC_API_KEY=sk-ant-api03-...
#   GEMINI_API_KEY=...
chmod 600 .env
set -a; source .env; set +a
```

Verify:

```bash
echo "anthropic len: ${#ANTHROPIC_API_KEY}    (expect ~108)"
echo "gemini    len: ${#GEMINI_API_KEY}       (expect ~39)"
```

---

## 3. Dry-run a pass (free — no API calls)

Confirms the file list, categorisation, and policy resolution. Makes zero
API calls.

```bash
node tools/run-pass.mjs \
  --study=yotsuba-claims \
  --policy=opus-4-7 \
  --dry-run
```

You should see a summary like:

```
DRY RUN — would author 75 files, total estimated cost $28–32 (premium policy)
  policy:   opus-4-7  (sha256: ...)
  brief:    case-studies/yotsuba-claims-platform/brief.md  (sha256: ...)
  design:   case-studies/yotsuba-claims-platform/design.md  (sha256: ...)
  files:    src/main.ts, src/app.module.ts, ...
```

If the file list or hashes don't match what you expect from the dashboard,
**stop here and open an issue.** Subsequent steps will spend real money.

---

## 4. Run a single pass (real API calls — costs money)

We always recommend `tmux` / `screen` for the long ones so the run survives a
closed terminal:

```bash
tmux new -s yotsuba-pass1
# inside tmux:

node tools/run-pass.mjs \
  --study=yotsuba-claims \
  --policy=opus-4-7 \
  --budget=40       # hard ceiling — driver halts if cost crosses this
```

The driver prints live progress per file:

```
[ 12/75 ]  src/claims-fnol/claims.controller.ts
           model=claude-opus-4-5-20250929  retry=0
           tokens 4523 in / 3812 cached / 1207 out
           cost $0.0924  latency 8.7s  cache-hit 84%
```

If a file truncates or returns malformed JSON, the driver retries once with
2× output budget. If interrupted, resume with `--resume` (skips files
already written).

### Verify the pass

```bash
# Install the deps the model authored into the pass's package.json
cd case-studies/yotsuba-claims-platform/passes/opus-4-7
npm install --no-audit --no-fund
cd ../../../..

node tools/verify.mjs --study=yotsuba-claims --pass=opus-4-7
```

Expected ending:

```
build_ok      = true
ts_errors     = 0
tests         = 47
tests_passed  = 47
test_pass_rate = 100%
manifest updated: case-studies/yotsuba-claims-platform/passes/opus-4-7/manifest.json
```

If `build_ok=false`, share the verifier output and the regen pipeline can
queue refinement packets to auto-fix.

---

## 5. Repeat for each policy you want to compare

```bash
# Pure-Anthropic tier-down comparisons
node tools/run-pass.mjs --study=yotsuba-claims --policy=sonnet-4-6  --budget=15
node tools/run-pass.mjs --study=yotsuba-claims --policy=haiku-4-5   --budget=8

# Orchestrated passes (the headlines)
node tools/run-pass.mjs --study=yotsuba-claims --policy=opus-4-7-with-gemini-3-5-flash --budget=12
node tools/run-pass.mjs --study=yotsuba-claims --policy=opus-4-7-with-gemini-3-1-pro   --budget=20

# Verify each
node tools/verify.mjs --study=yotsuba-claims --pass=sonnet-4-6
node tools/verify.mjs --study=yotsuba-claims --pass=haiku-4-5
node tools/verify.mjs --study=yotsuba-claims --pass=opus-4-7-with-gemini-3-5-flash
node tools/verify.mjs --study=yotsuba-claims --pass=opus-4-7-with-gemini-3-1-pro
```

You can run multiple passes **in parallel** in separate terminal windows; they
write to disjoint pass directories.

---

## 6. Score quality (LLM-as-judge)

After verifying all passes, run the rubric judge:

```bash
node tools/run-judge.mjs --study=yotsuba-claims
```

This sends each pass's artifacts side-by-side with the Opus-only reference to
**Claude Opus** with `judge/rubric.md` and writes scores into each manifest's
`quality_scores` block. Cost: ~$3–6 for a 5-pass study.

If you want a second opinion to cross-check Opus judge bias:

```bash
node tools/run-judge.mjs --study=yotsuba-claims --judge=gemini-2.5-pro
```

This writes scores under `quality_scores_alt`. The dashboard will surface both
when present.

---

## 7. Render the dashboard locally

```bash
cd dashboard
npm run prepare-data        # copies manifests + telemetry from case-studies/ → public/data/
npm run dev                 # http://localhost:5173
```

Open the local URL. You should see both case studies as cards on the
landing page, each clickable.

To compare your numbers against the published study:

| Compare | How |
|---|---|
| Total cost per pass | Card on the Executive view — should match within ±5% (cache variance) |
| Per-call telemetry | Engineering view's "Per-call audit" — diff against the published `telemetry.jsonl` |
| Per-file artifacts | Engineering view's "Per-file artifact diff" — should be byte-identical for deterministic-output files (configs, schemas), close-but-not-identical for prose |
| Quality scores | Executive view's "Quality scores per pass" — within ±0.25 of published |

---

## 8. Spot-check the headline number without running the full study

If you just want to verify "the orchestrated pass really does cost ~95% less,"
you can:

1. **Skip Pass 1 baseline** and trust the published Pass 1 manifest.
2. Run only the orchestrated pass (`opus-4-7-with-gemini-3-5-flash`) yourself.
3. Compare your `total_cost_usd` against the published one and against the
   published Pass 1 baseline.

Cost: ~$12–18. Wall-clock: 30–60 min.

---

## 9. Verify against vendor invoices

The dashboard publishes vendor invoice screenshots at
`case-studies/<study>/evidence/`. Compare:

```bash
# After running, check that your manifest matches your vendor billing
cat case-studies/yotsuba-claims-platform/passes/<pass-id>/manifest.json | jq '.total_cost_usd'

# Then look at your Anthropic / Google AI Studio billing dashboard for the same window.
# Should match within ±$1.
```

We will not publish a pass whose manifest disagrees with the vendor invoice.

---

## 10. Continuous-reproducibility check (free)

The `.github/workflows/study.yml` workflow re-runs the verifier on a small
slice (`--limit=3`) of each pass on every push. If the pipeline ever stops
being re-runnable, this catches it immediately. The status badge is wired
into the dashboard's "Verified by · CI green" indicator.

You can run the same check locally without spending API money:

```bash
node tools/verify.mjs --study=yotsuba-claims --pass=opus-4-7 --limit=3
```

---

## Troubleshooting

**`404 model not found` from the Anthropic API.** Means a label in a policy
YAML (e.g. `claude-opus-4-7`) is being passed through unchanged. The policy's
`model_name` field is the actual API model — fix that and re-run.

```bash
# List models your account has access to:
curl https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" | jq
```

**Cost climbing faster than expected.** `--budget` is a hard stop. The driver
halts the moment cumulative cost crosses the budget. Restart with a higher
budget after reviewing.

**Cache hit ratio shows 0%.** Anthropic's prompt cache TTL is 5 min. If
file-authoring calls take >30 s each and there are >10 calls per file, cache
misses accumulate. Acceptable for credibility (the cost numbers reflect a
realistic enterprise scenario); look for an enabled **extended-cache 1-hour
TTL beta** if you want hotter cache hits.

**Resume after a crash:**

```bash
node tools/run-pass.mjs \
  --study=yotsuba-claims --policy=opus-4-7 --budget=40 --resume
```

Skips files that already exist in the target. Telemetry appends rather than
overwrites.

**My total cost differs from the published number by >5%.** Compare:
1. The brief / design / policy SHA-256s in your manifest vs. the published one.
   (If different, you're not running the same inputs.)
2. The cache hit rate. The same brief run with cold cache costs ~25% more.
3. The model substitution mapping. Some policies label `claude-opus-4-7` but
   the actual API model is `claude-opus-4-5-20250929` (or whichever was
   shipping at the published run's date). Different model versions =
   different costs.

If the manifest pins are identical and cache is warm, open an issue — we
want to know.

---

## What to do with your re-run

If your numbers reproduce within ±5%: you've independently verified the
study. We'd love a short note (PR appending to `INDEPENDENT_REVIEW.md`)
saying "I re-ran X passes and observed Y." This is the highest single
credibility lift available to a study like this.

If your numbers don't reproduce: **open an issue.** Either we have a bug
worth fixing, or your re-run has revealed something about the study's
sensitivity that we should document. Either outcome makes the study
stronger.

---

*Maintained by Tilicho Labs.*
