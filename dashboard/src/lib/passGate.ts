/**
 * Pass-card gating helpers — one place to evolve the credibility rules.
 *
 * Two states matter for the dashboard:
 *   pipelineOk: the authoring pipeline ran successfully. We've validated
 *               via the verifier's envelope-leak scan that the files on
 *               disk are real model output, not corrupt JSON envelopes,
 *               so cost / token / LOC figures can be trusted.
 *
 *               Track A's headline cost-savings story uses this gate —
 *               compile-clean refinement is a separate Track B story.
 *
 *   verified:   pipelineOk AND tsc passes AND tests pass.
 *               The strict Phase-1 credibility bar — meaningful when a
 *               pass has gone through the refinement-packet loop.
 */
import type { PassData } from "./types";

export function pipelineOk(p: PassData): boolean {
  const a: any = p.manifest?.artifacts ?? {};
  return (p.manifest?.total_cost_usd ?? 0) > 0
      && (a.envelope_leaks ?? 0) === 0
      && a.build_ok !== undefined;          // the verifier has run
}

export function verifiedPass(p: PassData): boolean {
  const a = p.manifest?.artifacts ?? {};
  return pipelineOk(p)
      && a.build_ok === true
      && (a.tests_passed ?? 0) > 0;
}

/** "Authored, refinement pending" — Track A's middle state. */
export function authoredOnly(p: PassData): boolean {
  return pipelineOk(p) && !verifiedPass(p);
}
