---
description: Run the AI-SDLC workflow end-to-end on Opus only (baseline pass). Produces sample-project/pass1-opus-only/ with full artifacts + telemetry. Establishes the cost ceiling for the comparison.
argument-hint: <path-to-brief.md>
---

Invoke the `orchestrator` subagent to execute Pass 1 (baseline, Opus-only) of the AI-SDLC workflow.

**Brief file:** $ARGUMENTS

**Pass settings (the orchestrator must honor these):**
- `pass_id`: `pass1`
- `output_dir`: `sample-project/pass1-opus-only/`
- `telemetry_path`: `sample-project/pass1-opus-only/telemetry.jsonl`
- `manifest_path`: `sample-project/pass1-opus-only/manifest.json`
- `policy_name`: `opus-only` (every phase routes to Opus; no MCP delegation)

**HITL gates active:** Gate 1 (requirements), Gate 2 (design), Gate 3 (security review), Gate 4 (final acceptance).

Begin now.
