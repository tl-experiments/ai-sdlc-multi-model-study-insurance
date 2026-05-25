/**
 * Cost computation utilities.
 * Pricing values come from the loaded Policy (so they stay in sync with
 * whichever policy YAML the user picked) — this module only does the math.
 */
export function computeCostUsd(tokens, pricing) {
    const inputFresh = tokens.input - tokens.input_cached;
    const inputFreshCost = (inputFresh / 1_000_000) * pricing.input;
    const inputCachedCost = (tokens.input_cached / 1_000_000) * pricing.input_cached;
    const outputCost = (tokens.output / 1_000_000) * pricing.output;
    return round6(inputFreshCost + inputCachedCost + outputCost);
}
export function round6(n) {
    return Math.round(n * 1_000_000) / 1_000_000;
}
/**
 * Approximate token count for a string.
 * Calibrated to be within ~10% of true tokenizer output for English + code,
 * which is good enough for telemetry & cost estimation. Avoids pulling
 * a heavy tokenizer dependency into the MCP server.
 *
 * Rule: 1 token ~= 4 chars of English, ~3.5 chars of code.
 */
export function estimateTokens(text) {
    if (!text)
        return 0;
    // Slight bias toward code-like content (denser tokens).
    return Math.ceil(text.length / 3.8);
}
//# sourceMappingURL=pricing.js.map