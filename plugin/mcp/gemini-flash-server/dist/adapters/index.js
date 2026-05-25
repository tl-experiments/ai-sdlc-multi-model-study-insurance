import { GeminiFlashAdapter } from "./GeminiFlashAdapter.js";
import { BuiltinAnthropicAdapter } from "./BuiltinAnthropicAdapter.js";
/**
 * Adapter registry. To add a new vendor:
 *   1. Implement a new ModelAdapter (e.g. OpenAIAdapter).
 *   2. Add a case to createAdapter below, keyed on the policy's `adapter` field.
 *   3. Reference it in any policy YAML as `adapter: mcp:<your-server-name>`.
 */
export function createAdapter(config) {
    if (config.adapter === "builtin-anthropic")
        return new BuiltinAnthropicAdapter(config);
    if (config.adapter === "mcp:gemini-flash-server")
        return new GeminiFlashAdapter(config);
    throw new Error(`No adapter registered for '${config.adapter}'. Implement one and register it in adapters/index.ts.`);
}
//# sourceMappingURL=index.js.map