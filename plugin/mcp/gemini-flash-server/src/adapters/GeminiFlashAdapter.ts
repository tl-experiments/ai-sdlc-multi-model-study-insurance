/**
 * GeminiFlashAdapter — calls Gemini 2.5 Flash via @google/generative-ai,
 * with explicit context caching for the stable project header to amortize
 * the input cost across many TaskPackets in a single pass.
 *
 * Falls back gracefully to implicit caching if explicit cache creation fails.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
import type { ExecutionResult, ModelConfig, TaskPacket } from "../types.js";
import { computeCostUsd, estimateTokens } from "../pricing.js";
import type { ModelAdapter } from "./ModelAdapter.js";

export class GeminiFlashAdapter implements ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;
  private genAI: GoogleGenerativeAI;
  private cacheManager?: GoogleAICacheManager;
  private cacheNamesByKey = new Map<string, string>(); // cacheContext -> cachedContentName
  private cacheHeader = ""; // the stable text we cache (set once via primeCache)

  constructor(config: ModelConfig) {
    this.id = config.id;
    this.modelConfig = config;
    const envKey = config.auth?.env ?? "GEMINI_API_KEY";
    const apiKey = process.env[envKey];
    if (!apiKey) {
      throw new Error(
        `${envKey} not set. The GeminiFlashAdapter requires this env var to call Google's API.`
      );
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    try {
      this.cacheManager = new GoogleAICacheManager(apiKey);
    } catch {
      // Older SDKs may not export this; we'll fall back to implicit caching.
      this.cacheManager = undefined;
    }
  }

  /**
   * Prime the explicit context cache with the stable project header.
   * Call once at the start of a pass. cacheKey is e.g. "pass2:workforce-ops".
   */
  async primeCache(cacheKey: string, header: string): Promise<void> {
    this.cacheHeader = header;
    if (!this.cacheManager) return;
    try {
      const created = await this.cacheManager.create({
        model: `models/${this.modelConfig.model_name}`,
        displayName: cacheKey,
        contents: [{ role: "user", parts: [{ text: header }] }],
        ttlSeconds: 3600,
      });
      if (created?.name) {
        this.cacheNamesByKey.set(cacheKey, created.name);
      }
    } catch (err) {
      // Explicit caching not available / quota / model mismatch — fall back to inlining the header each call.
      // Savings degrade from ~75% to ~50% but still material.
      this.cacheManager = undefined;
    }
  }

  async execute(packet: TaskPacket, cacheContext?: string): Promise<ExecutionResult> {
    const start = Date.now();
    const cacheName = cacheContext ? this.cacheNamesByKey.get(cacheContext) : undefined;
    const cacheHit = !!cacheName;

    const userPrompt = buildUserPrompt(packet, !cacheHit ? this.cacheHeader : "");

    try {
      const model = this.genAI.getGenerativeModel(
        cacheHit
          ? { model: this.modelConfig.model_name, cachedContent: { name: cacheName! } as any }
          : { model: this.modelConfig.model_name }
      );

      const generationConfig: any = {
        temperature: 0.2,
        maxOutputTokens: packet.budget.maxOutputTokens,
        responseMimeType: "application/json",
      };
      // Some SDK versions support responseSchema natively.
      if (packet.outputSchema) generationConfig.responseSchema = packet.outputSchema;

      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig,
      });

      const text = resp.response.text();
      const usage = (resp.response as any).usageMetadata ?? {};
      const inputTokens = usage.promptTokenCount ?? estimateTokens(userPrompt);
      const cachedTokens = usage.cachedContentTokenCount ?? (cacheHit ? estimateTokens(this.cacheHeader) : 0);
      const outputTokens = usage.candidatesTokenCount ?? estimateTokens(text);

      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }

      const tokens = {
        input: inputTokens,
        input_cached: cachedTokens,
        output: outputTokens,
      };
      return {
        result: parsed,
        tokens,
        cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
        latency_ms: Date.now() - start,
        cache_hit: cacheHit,
        success: true,
      };
    } catch (err: any) {
      const tokens = { input: estimateTokens(userPrompt), input_cached: 0, output: 0 };
      return {
        result: null,
        tokens,
        cost_usd: computeCostUsd(tokens, this.modelConfig.pricing),
        latency_ms: Date.now() - start,
        cache_hit: cacheHit,
        success: false,
        error: err?.message ?? String(err),
      };
    }
  }
}

function buildUserPrompt(packet: TaskPacket, headerInline: string): string {
  const inputsBlock = packet.inputs
    .map((s) => `### ${s.path}  — ${s.reason}\n\`\`\`\n${s.content}\n\`\`\``)
    .join("\n\n");

  return [
    headerInline ? `## Project header (inlined; cache miss)\n${headerInline}\n` : "",
    `## Task — ${packet.id} (${packet.phase} / ${packet.task_type})`,
    `Module: ${packet.module}`,
    ``,
    `### Instruction`,
    packet.instruction,
    ``,
    `### Inputs`,
    inputsBlock || "_(none)_",
    ``,
    `### Acceptance criteria`,
    ...packet.acceptance.map((a) => `- ${a}`),
    ``,
    `### Output`,
    `Respond with strictly valid JSON conforming to the provided response schema.`,
    `Do not include any prose, markdown, or commentary outside the JSON.`,
  ]
    .filter(Boolean)
    .join("\n");
}
