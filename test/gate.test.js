'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gate = require('../gate.js');
const { decideExit } = require('../enforce.js');

const FIX = path.join(__dirname, 'fixtures');

/** Run the gate in a scratch cwd against a fixture; returns the result and the written files. */
function runWith(fixture, extra = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'certusqa-gate-'));
  const results = fixture ? path.join(cwd, 'test-results', 'results.json') : path.join(cwd, 'missing.json');
  if (fixture) {
    fs.mkdirSync(path.dirname(results), { recursive: true });
    fs.copyFileSync(path.join(FIX, fixture), results);
  }
  const opts = gate.readOptions({ GATE_RESULTS: path.relative(cwd, results), GATE_MEDIA_DIR: extra.mediaDir || 'test-results', GATE_MODE: extra.mode, GATE_STRICT: extra.strict, GATE_OUTPUT_DIR: 'certusqa-gate' });
  const result = gate.run(opts, cwd);
  gate.writeOutputs(result);
  const written = fs.readdirSync(path.join(cwd, 'certusqa-gate'));
  const proofs = fs.readdirSync(path.join(cwd, 'certusqa-gate', 'proof'));
  return { cwd, result, written, proofs, gateJson: JSON.parse(fs.readFileSync(path.join(cwd, 'certusqa-gate', 'gate.json'), 'utf8')) };
}

describe('summarize — the real Playwright JSON shape', () => {
  it('reads test.status (expected/unexpected/flaky/skipped) and per-attempt results', () => {
    const report = JSON.parse(fs.readFileSync(path.join(FIX, 'results-mixed.json'), 'utf8'));
    const s = gate.summarize(report);
    assert.deepEqual({ passed: s.passed, failed: s.failed, flaky: s.flaky, skipped: s.skipped, total: s.total }, { passed: 1, failed: 1, flaky: 1, skipped: 1, total: 4 });
    const failed = s.cases.find((c) => c.status === 'unexpected');
    assert.equal(failed.title, 'checkout › price regression');
    assert.equal(failed.file, 'sample.spec.js');
    assert.equal(failed.line, 5);
    assert.deepEqual(failed.attempts, ['failed', 'failed']);
    const flaky = s.cases.find((c) => c.status === 'flaky');
    assert.deepEqual(flaky.attempts, ['failed', 'passed']);
    assert.match(flaky.error, /Timeout 30000ms/);
  });

  it('strips ANSI colour and the Received block from error text, and caps length', () => {
    const raw = '\u001b[31mError: displayed price\u001b[39m\n\nexpect(received).toBe(expected)\n\nExpected: "Rs. 500"\nReceived: "Rs. 250"';
    const clean = gate.sanitizeError(raw);
    assert.ok(!clean.includes('\u001b'));
    assert.ok(!clean.includes('Rs. 250'), 'observed page text is not copied into the artifact');
    assert.ok(clean.includes('Expected: "Rs. 500"'));
    assert.equal(gate.sanitizeError('x'.repeat(1000)).length, 401);
    assert.equal(gate.sanitizeError(null), null);
  });
});

describe('decide — four verdicts, and a missing report is never green', () => {
  it('BLOCK_DEPLOY when any test failed after retries', () => {
    const { gateJson } = runWith('results-mixed.json');
    assert.equal(gateJson.verdict, 'BLOCK_DEPLOY');
  });
  it('CLEAR_TO_DEPLOY only when everything passed first time and no media exists', () => {
    const { gateJson } = runWith('results-all-pass.json');
    assert.equal(gateJson.verdict, 'CLEAR_TO_DEPLOY');
    assert.deepEqual(gateJson.proofArtifacts, []);
  });
  it('REVIEW_ARTIFACTS when a test passed only on retry', () => {
    const { gateJson, proofs } = runWith('results-flaky.json');
    assert.equal(gateJson.verdict, 'REVIEW_ARTIFACTS');
    assert.equal(proofs.length, 1);
    assert.match(proofs[0], /^pa_flaky_/);
  });
  it('REVIEW_ARTIFACTS when all passed but failure media is on disk', () => {
    const { cwd, result } = runWith('results-all-pass.json');
    fs.mkdirSync(path.join(cwd, 'test-results', 'old-failure'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'test-failed-1.png'), 'png');
    // Playwright 1.62+ can write screenshots as WebP; a WebP failure shot must count as media too.
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'test-failed-2.webp'), 'webp');
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'notes.txt'), 'not media');
    const again = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'test-results' }), cwd);
    assert.equal(result.gate.verdict, 'CLEAR_TO_DEPLOY');
    assert.equal(again.gate.verdict, 'REVIEW_ARTIFACTS');
    assert.deepEqual(again.gate.media.sort(), ['test-results/old-failure/test-failed-1.png', 'test-results/old-failure/test-failed-2.webp']);
  });
  it('INSUFFICIENT_EVIDENCE when the report is absent, corrupt, or has no tests', () => {
    assert.equal(runWith(null).gateJson.verdict, 'INSUFFICIENT_EVIDENCE');
    const corrupt = runWith('results-corrupt.json').gateJson;
    assert.equal(corrupt.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.equal(corrupt.reportStatus, 'unparseable');
    assert.match(corrupt.note, /could not be parsed/);
    const empty = runWith('results-empty.json').gateJson;
    assert.equal(empty.verdict, 'INSUFFICIENT_EVIDENCE');
    assert.match(empty.note, /contains no tests/);
  });
  it('absent report: counts are null, not zero', () => {
    const { gateJson } = runWith(null);
    assert.deepEqual(gateJson.summary, { passed: null, failed: null, flaky: null, skipped: null, total: null });
    assert.equal(gateJson.reportStatus, 'absent');
    assert.match(gateJson.note, /Add reporter/);
  });
});

describe('Proof Artifacts — engine-shaped, honestly unjudged', () => {
  it('writes one file per failure and per flaky test with the engine schema fields', () => {
    const { cwd, proofs, gateJson } = runWith('results-mixed.json');
    assert.equal(proofs.length, 2);
    assert.deepEqual(gateJson.proofArtifacts.sort(), proofs.map((f) => f.replace(/\.json$/, '')).sort());
    for (const f of proofs) {
      const a = JSON.parse(fs.readFileSync(path.join(cwd, 'certusqa-gate', 'proof', f), 'utf8'));
      assert.equal(a.artifactType, 'PROOF_ARTIFACT');
      assert.equal(a.schemaVersion, '1.1.0');
      assert.equal(a.classification.outcome, 'INCONCLUSIVE');
      assert.equal(a.classification.failKind, 'unjudged');
      assert.ok(['NEEDS_TRIAGE', 'FLAKY'].includes(a.classification.category));
      assert.equal(a.remediation.confidence, 'none');
      assert.ok(a.rootCause.statement.length > 20);
      assert.equal(a.gate.verdict, 'BLOCK_DEPLOY');
    }
  });
  it('ids are stable across runs for the same test', () => {
    const a = runWith('results-mixed.json').proofs;
    const b = runWith('results-mixed.json').proofs;
    assert.deepEqual(a, b);
  });
  it('never copies the Received value into an artifact', () => {
    const { cwd, proofs } = runWith('results-mixed.json');
    for (const f of proofs) {
      const text = fs.readFileSync(path.join(cwd, 'certusqa-gate', 'proof', f), 'utf8');
      assert.ok(!/Received/.test(text), `${f} leaks a Received block`);
      assert.ok(!text.includes('\u001b'), `${f} contains ANSI`);
    }
  });
});

describe('summary and outputs', () => {
  it('renders a markdown summary with the verdict, counts and artifact table', () => {
    const { result } = runWith('results-mixed.json');
    const md = result.summaryMarkdown;
    assert.match(md, /CertusQA Gate: `BLOCK_DEPLOY`/);
    assert.match(md, /\| 1 \| 1 \| 1 \| 1 \| 4 \|/);
    assert.match(md, /pa_unjudged_/);
    assert.match(md, /report-only/);
  });
  it('writes GITHUB_OUTPUT and GITHUB_STEP_SUMMARY when set', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'certusqa-gate-gh-'));
    const out = path.join(cwd, 'out.txt');
    const sum = path.join(cwd, 'summary.md');
    process.env.GITHUB_OUTPUT = out;
    process.env.GITHUB_STEP_SUMMARY = sum;
    try {
      const results = path.join(cwd, 'r.json');
      fs.copyFileSync(path.join(FIX, 'results-flaky.json'), results);
      const r = gate.run(gate.readOptions({ GATE_RESULTS: 'r.json', GATE_MEDIA_DIR: 'none', GATE_OUTPUT_DIR: 'g' }), cwd);
      gate.writeOutputs(r);
    } finally {
      delete process.env.GITHUB_OUTPUT;
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(outputs.verdict, 'REVIEW_ARTIFACTS');
    assert.equal(outputs.passed, '1');
    assert.equal(outputs.flaky, '1');
    assert.equal(outputs['report-status'], 'parsed');
    assert.ok(path.isAbsolute(outputs['output-dir']));
    assert.match(fs.readFileSync(sum, 'utf8'), /REVIEW_ARTIFACTS/);
  });
});

describe('enforce — the only step that can go red', () => {
  it('report-only never fails', () => {
    for (const verdict of gate.VERDICTS) assert.equal(decideExit({ mode: 'report-only', verdict }).exitCode, 0, verdict);
  });
  it('enforce fails on BLOCK_DEPLOY and INSUFFICIENT_EVIDENCE, passes CLEAR', () => {
    assert.equal(decideExit({ mode: 'enforce', verdict: 'BLOCK_DEPLOY' }).exitCode, 1);
    assert.equal(decideExit({ mode: 'enforce', verdict: 'INSUFFICIENT_EVIDENCE' }).exitCode, 1);
    assert.equal(decideExit({ mode: 'enforce', verdict: 'CLEAR_TO_DEPLOY' }).exitCode, 0);
  });
  it('REVIEW_ARTIFACTS blocks only under strict', () => {
    assert.equal(decideExit({ mode: 'enforce', verdict: 'REVIEW_ARTIFACTS' }).exitCode, 0);
    assert.equal(decideExit({ mode: 'enforce', strict: 'true', verdict: 'REVIEW_ARTIFACTS' }).exitCode, 1);
  });
  it('an unset verdict is treated as insufficient evidence', () => {
    assert.equal(decideExit({ mode: 'enforce' }).exitCode, 1);
  });
});
