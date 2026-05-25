/**
 * Shared type definitions for the multi-model orchestration layer.
 * The TaskPacket is the cost-control linchpin — every cross-model call uses it.
 */

export type Phase =
  | "requirements_analysis"
  | "architecture_design"
  | "plan_task_packets"
  | "codegen"
  | "tests"
  | "docs"
  | "debug"
  | "senior_code_review"
  | "security_review"
  | "refactor"
  | "final_report";

export interface FileSlice {
  path: string;
  content: string;
  reason: string; // why this slice was included (helps audit context bloat)
}

export interface TaskPacket {
  id: string;                // e.g. tp_codegen_042
  phase: Phase;
  task_type: string;         // controller_handler, dto, test_unit, etc.
  module: string;            // employees, leave, time, reports, auth, audit, cross
  instruction: string;       // crisp imperative, <300 tokens
  inputs: FileSlice[];       // sliced file fragments only — NEVER full Opus history
  outputSchema: Record<string, any>; // JSON schema for structured output
  acceptance: string[];      // testable bullets
  budget: { maxInputTokens: number; maxOutputTokens: number };
  retry_count?: number;
  pass_id: string;           // "pass1" | "pass2"
}

export interface TelemetryEvent {
  ts: string;                // ISO-8601
  pass: string;              // "pass1" | "pass2"
  phase: Phase;
  task_type: string;
  task_id: string;
  module: string;
  model: string;             // canonical model name from pricing table
  routed_by: "orchestrator" | "fallback" | "manual";
  routing: {
    policy_name: string;
    policy_version: number;
    rule_index: number;      // -1 = default
    rule_reason: string;
  };
  input_tokens: number;
  input_tokens_cached: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  retry_count: number;
  artifact_path?: string;
  error?: string;
}

export interface ModelPricing {
  input: number;          // USD per 1M tokens
  input_cached: number;   // USD per 1M cached tokens
  output: number;         // USD per 1M tokens
}

export interface ModelConfig {
  id: string;
  adapter: string;        // "builtin-anthropic" | "mcp:<server>"
  model_name: string;
  pricing: ModelPricing;
  auth?: { env: string };
}

export type RuleMatcher = {
  phase?: string | string[];
  task_type?: string | string[];
  module?: string | string[];
  retry_count?: { lt?: number; lte?: number; gt?: number; gte?: number; eq?: number };
};

export type Rule =
  | { when: RuleMatcher; use: string; reason?: string }
  | { default: string; reason?: string };

export interface Policy {
  version: number;
  name: string;
  models: ModelConfig[];
  rules: Rule[];
}

export interface RoutingDecision {
  modelId: string;
  reason: string;
  ruleIndex: number;   // -1 if default
}

export interface ExecutionResult {
  result: any;
  tokens: { input: number; input_cached: number; output: number };
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
  success: boolean;
  error?: string;
}
