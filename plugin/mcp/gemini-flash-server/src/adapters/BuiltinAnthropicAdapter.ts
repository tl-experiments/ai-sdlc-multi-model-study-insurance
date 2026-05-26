/**
 * BuiltinAnthropicAdapter — calls Claude (Opus / Sonnet / Haiku) directly
 * via @anthropic-ai/sdk with prompt caching enabled on the system block.
 *
 * In production, the Claude Code plugin would route Anthropic work through
 * the host CLI's own model dispatch (no API key needed in our process).
 * This adapter exists so the Pass-2 driver script can run standalone
 * outside the CC session — useful for CI replays and judge.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";

export class BuiltinAnthropicAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private client: Anthropic;
  private cachedSystem = "";

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    const envKey = config.auth?.env ?? "ANTHROPIC_API_KEY";
    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(`${envKey} not set for BuiltinAnthropicAdapter (model ${config.id})`);
    }
    this.client = new Anthropic({ apiKey });
  }

  setSystemCache(text: string) {
    this.cachedSystem = text;
  }

  async execute(packet: TaskPacket): Promise<ExecutionResult> {
    const start = Date.now();
    const userPrompt = buildAnthropicUserPrompt(packet);
    try {
      // Newer Claude models (4-7+) reject the `temperature` param. We omit it
      // entirely for those; the model uses its default (≈0.2 for code, low
      // enough for our deterministic-output need).
      const isNewSeries = /claude-(opus|sonnet|haiku)-4-[6-9]/i.test(this.modelConfig.model_name)
                       || /claude-(opus|sonnet|haiku)-[5-9]-/i.test(this.modelConfig.model_name);
      const req: any = {
        model: this.modelConfig.model_name,
        max_tokens: packet.budget.maxOutputTokens,
        system: this.cachedSystem
          ? [{ type: "text", text: this.cachedSystem, cache_control: { type: "ephemeral" } } as any]
          : undefined,
        messages: [{ role: "user", content: userPrompt }],
      };
      if (!isNewSeries) req.temperature = 0.2;
      const resp = await this.client.messages.create(req);

      const text = resp.content
        .map((b) => ("text" in b ? (b as any).text : ""))
        .join("\n")
        .trim();

      const usage = resp.usage as any;
      const tokens = {
        input: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
        input_cached: usage?.cache_read_input_tokens ?? 0,
        output: usage?.output_tokens ?? estimateTokens(text),
      };

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }

      return {
        result: parsed,
        tokens,
        cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
        latency_ms: Date.now() - start,
        cache_hit: tokens.input_cached > 0,
        success: true,
      };
    } catch (err: any) {
      const tokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
      return {
        result: null,
        tokens,
        cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
        latency_ms: Date.now() - start,
        cache_hit: false,
        success: false,
        error: err?.message ?? String(err),
      };
    }
  }
}

function buildAnthropicUserPrompt(packet: TaskPacket): string {
  const inputs = packet.inputs
    .map((s) => `### ${s.path} — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");
  return [
    `## TaskPacket ${packet.id} (${packet.phase}/${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    inputs || "_(none)_",
    ``,
    `### Acceptance`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output format`,
    `Respond with strictly valid JSON conforming to this schema:`,
    "```json",
    JSON.stringify(packet.outputSchema, null, 2),
    "```",
    `No prose outside the JSON object.`,
  ].join("\n");
}
