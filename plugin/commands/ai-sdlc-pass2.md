---
description: Run the AI-SDLC workflow with multi-model orchestration. Premium phases stay on Opus; mechanical phases dispatch to Gemini Flash via the bundled MCP server. Produces sample-project/pass2-orchestrated/. Optional --policy=<name> selects a routing policy.
argument-hint: [--policy=<policy-name>] <path-to-brief.md>
---

Invoke the `orchestrator` subagent to execute Pass 2 (orchestrated, multi-model) of the AI-SDLC workflow.

**Arguments:** $ARGUMENTS

**Argument parsing (the orchestrator must do this):**
- If the arguments contain `--policy=<name>`, use that policy name; otherwise default to `default-2-tier`.
- The remaining positional argument is the path to the brief file.

**Pass settings:**
- `pass_id`: `pass2`
- `output_dir`: `sample-project/pass2-orchestrated/`
- `telemetry_path`: `sample-project/pass2-orchestrated/telemetry.jsonl`
- `manifest_path`: `sample-project/pass2-orchestrated/manifest.json`
- `policy_name`: as parsed above (or `default-2-tier`)
- `cache_context`: `pass2:workforce-ops` (stable header cache key for Gemini)

**Requirements before starting:**
- `GEMINI_API_KEY` env var must be set; if not, abort with a clear message.
- The MCP server `gemini-flash-server` must be registered (it is, via the plugin manifest).

**HITL gates active:** Gate 1 (requirements), Gate 2 (design), Gate 3 (security review), Gate 4 (final acceptance).

Begin now.
