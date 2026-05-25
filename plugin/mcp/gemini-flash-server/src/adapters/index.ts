import type { ModelConfig } from "../types.js";
import type { ModelAdapter } from "./ModelAdapter.js";
import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";

/**
 * Adapter registry. To add a new vendor:
 *   1. Implement a new ModelAdapter (e.g. OpenAIAdapter).
 *   2. Add a case to createAdapter below, keyed on the policy's `adapter` field.
 *   3. Reference it in any policy YAML as `adapter: mcp:<your-server-name>`.
 */
export function createAdapter(config: ModelConfig): ModelAdapter {
  if (config.adapter === "builtin-anthropic") return new BuiltinAnthropicAdapter(config);
  if (config.adapter === "mcp:gemini-flash-server") return new GeminiFlashAdapter(config);
  throw new Error(
    `No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`
  );
}

export type { ModelAdapter } from "./ModelAdapter.js";
