import type { TelemetryEvent, Policy } from "./types";

/**
 * What-if simulator — replay telemetry events under an alternative policy
 * and recompute cost without re-running any LLMs.
 */
export function pickModel(
  ctx: { phase: string; task_type: string; module: string; retry_count: number },
  policy: Policy
): { modelId: string; reason: string; ruleIndex: number } {
  for (let i = 0; i < policy.rules.length; i++) {
    const r = policy.rules[i];
    if ("default" in r) continue;
    if (matches(r.when, ctx)) {
      return { modelId: r.use!, reason: r.reason ?? `rule ${i}`, ruleIndex: i };
    }
  }
  for (let i = 0; i < policy.rules.length; i++) {
    const r = policy.rules[i];
    if ("default" in r && r.default) return { modelId: r.default, reason: r.reason ?? "default", ruleIndex: -1 };
  }
  throw new Error("policy has no matching rule and no default");
}
function matches(m: any, ctx: any): boolean {
  if (!m) return true;
  if (m.phase !== undefined && !inSet(m.phase, ctx.phase)) return false;
  if (m.task_type !== undefined && !inSet(m.task_type, ctx.task_type)) return false;
  if (m.module !== undefined && !inSet(m.module, ctx.module)) return false;
  if (m.retry_count) {
    const r = ctx.retry_count, c = m.retry_count;
    if (c.lt !== undefined && !(r < c.lt)) return false;
    if (c.lte !== undefined && !(r <= c.lte)) return false;
    if (c.gt !== undefined && !(r > c.gt)) return false;
    if (c.gte !== undefined && !(r >= c.gte)) return false;
    if (c.eq !== undefined && !(r === c.eq)) return false;
  }
  return true;
}
function inSet(s: any, v: string): boolean { return Array.isArray(s) ? s.includes(v) : s === v; }

export function simulate(events: TelemetryEvent[], policy: Policy): {
  total_cost_usd: number;
  per_model: Record<string, number>;
  per_phase: Record<string, number>;
} {
  const modelById = Object.fromEntries(policy.models.map((m) => [m.id, m]));
  const per_model: Record<string, number> = {};
  const per_phase: Record<string, number> = {};
  let total = 0;
  let firstCostEfficientSeen = false;
  for (const ev of events) {
    const decision = pickModel(
      { phase: ev.phase, task_type: ev.task_type, module: ev.module, retry_count: 0 },
      policy
    );
    const m = modelById[decision.modelId];
    if (!m) continue;
    let input = ev.input_tokens, input_cached = ev.input_tokens_cached, output = ev.output_tokens;
    if (decision.modelId !== "opus") {
      input = Math.round(ev.input_tokens * 0.85);
      if (!firstCostEfficientSeen) { input_cached = 0; firstCostEfficientSeen = true; }
      else { input_cached = Math.round(input * 0.8); }
    }
    const fresh = Math.max(0, input - input_cached);
    const cost = (fresh / 1e6) * m.pricing.input
               + (input_cached / 1e6) * m.pricing.input_cached
               + (output / 1e6) * m.pricing.output;
    per_model[m.id] = (per_model[m.id] ?? 0) + cost;
    per_phase[ev.phase] = (per_phase[ev.phase] ?? 0) + cost;
    total += cost;
  }
  return { total_cost_usd: round6(total), per_model: roundAll(per_model), per_phase: roundAll(per_phase) };
}

function round6(n: number) { return Math.round(n * 1e6) / 1e6; }
function roundAll(o: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const k of Object.keys(o)) out[k] = round6(o[k]);
  return out;
}
