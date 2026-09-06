#!/usr/bin/env node
'use strict';

/**
 * The only step of the action that can fail the job, and it runs last so the
 * evidence has already been written and uploaded.
 *
 *   report-only  -> exit 0 whatever the verdict (the verdict is in the summary)
 *   enforce      -> BLOCK_DEPLOY and INSUFFICIENT_EVIDENCE exit 1;
 *                   REVIEW_ARTIFACTS exits 1 only when strict=true;
 *                   CLEAR_TO_DEPLOY exits 0.
 *
 * INSUFFICIENT_EVIDENCE blocks in enforce mode on purpose: a gate that passes
 * when the report is missing is a gate that passes when the tests did not run.
 */

/**
 * @param {{ mode?: string, strict?: string, verdict?: string }} env
 * @returns {{ exitCode: number, message: string }}
 */
function decideExit(env) {
  const mode = env.mode === 'enforce' ? 'enforce' : 'report-only';
  const strict = String(env.strict || '').toLowerCase() === 'true';
  const verdict = String(env.verdict || 'INSUFFICIENT_EVIDENCE');

  if (mode === 'report-only') {
    return { exitCode: 0, message: `certusqa-gate: ${verdict} recorded (report-only; set mode: enforce to block)` };
  }
  if (verdict === 'CLEAR_TO_DEPLOY') return { exitCode: 0, message: 'certusqa-gate: CLEAR_TO_DEPLOY' };
  if (verdict === 'REVIEW_ARTIFACTS') {
    return strict
      ? { exitCode: 1, message: 'certusqa-gate: REVIEW_ARTIFACTS blocks under strict enforcement — review the retries and failure media' }
      : { exitCode: 0, message: 'certusqa-gate: REVIEW_ARTIFACTS — not an automatic pass; a human decides. Set strict: true to block on this' };
  }
  return { exitCode: 1, message: `certusqa-gate: ${verdict} — not clear to deploy` };
}

module.exports = { decideExit };

if (require.main === module) {
  const { exitCode, message } = decideExit({ mode: process.env.GATE_MODE, strict: process.env.GATE_STRICT, verdict: process.env.GATE_VERDICT });
  (exitCode ? console.error : console.log)(message);
  process.exit(exitCode);
}
