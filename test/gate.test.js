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
  it('a green run stays green when media is merely present on disk', () => {
    /*
     * This test used to assert the opposite, and its own title gave the defect
     * away: "when all passed but FAILURE media is on disk". If everything
     * passed, none of it is failure media.
     *
     * `decide()` took any file matching png/webp/webm/zip anywhere under the
     * media dir as grounds for REVIEW_ARTIFACTS — note the fixture directory
     * is called `old-failure`, i.e. leftovers from an earlier run. Under
     * GATE_STRICT a REVIEW blocks, so a fully green run was blocked by a stale
     * screenshot. Playwright 1.64 makes `video: 'on'` ordinary, which turns a
     * rare annoyance into the common case: every green run would carry a webm.
     *
     * Media is still found, still listed and still uploaded as evidence. What
     * changed is that only media a FAILED or FLAKY result actually references
     * can bear on the verdict — and a green run has no such result, which is
     * why this one is now CLEAR.
     */
    const { cwd, result } = runWith('results-all-pass.json');
    fs.mkdirSync(path.join(cwd, 'test-results', 'old-failure'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'test-failed-1.png'), 'png');
    // Playwright 1.62+ can write screenshots as WebP; a WebP shot must still be LISTED.
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'test-failed-2.webp'), 'webp');
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'video.webm'), 'webm');
    fs.writeFileSync(path.join(cwd, 'test-results', 'old-failure', 'notes.txt'), 'not media');
    const again = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'test-results' }), cwd);

    assert.equal(result.gate.verdict, 'CLEAR_TO_DEPLOY', 'green with no media');
    assert.equal(again.gate.verdict, 'CLEAR_TO_DEPLOY', 'and green with media lying around');

    // still discovered, and still not the .txt
    assert.deepEqual(again.gate.media.sort(), [
      'test-results/old-failure/test-failed-1.png',
      'test-results/old-failure/test-failed-2.webp',
      'test-results/old-failure/video.webm',
    ]);
    // and it is named for what it is
    assert.deepEqual(again.gate.failureMedia, [], 'no failed or flaky result references any of it');
    assert.equal(again.gate.recordedMedia.length, 3, 'recorded, not failure evidence');
  });

  it('a failure BLOCKS and its media reaches the Proof Artifact', () => {
    // The other half of the same change: media that a failing result does
    // reference is failure evidence, must be named as such, and must travel
    // with the artifact a human will read.
    // Its own fixture: results-mixed attaches only error-context.md, so its
    // png and webm are found by the directory heuristic and referenced by
    // nothing. A real failing run attaches both, with paths.
    const { cwd, gateJson } = runWith('results-failure-with-media.json');
    const dir = path.join(cwd, 'test-results', 'records-a-video-on-failure');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-failed-1.png'), 'png');
    fs.writeFileSync(path.join(dir, 'video.webm'), 'webm');
    const again = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'test-results' }), cwd);

    assert.equal(gateJson.verdict, 'BLOCK_DEPLOY');
    assert.equal(again.gate.verdict, 'BLOCK_DEPLOY', 'media does not change a block');
    assert.ok(again.gate.failureMedia.length > 0, 'the failure references its own evidence');
    for (const m of again.gate.failureMedia) {
      assert.ok(again.gate.media.includes(m), `${m} is also in the full listing`);
      assert.ok(!again.gate.recordedMedia.includes(m), `${m} is not double-counted as merely recorded`);
    }
    const failing = again.artifacts.find((a) => a.id.startsWith('pa_unjudged_'));
    assert.ok(failing, 'the failure has a Proof Artifact');
    assert.ok(failing.evidence.media.length > 0, 'and the artifact carries its media');
  });

  it('a flaky run REVIEWS, with or without media', () => {
    const { cwd, gateJson } = runWith('results-flaky.json');
    assert.equal(gateJson.verdict, 'REVIEW_ARTIFACTS');
    fs.mkdirSync(path.join(cwd, 'test-results', 'extra'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'test-results', 'extra', 'video.webm'), 'webm');
    const again = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'test-results' }), cwd);
    assert.equal(again.gate.verdict, 'REVIEW_ARTIFACTS', 'the retry is the reason, not the webm');
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

describe('G2 — a green run that compared nothing says so', () => {
  /*
   * Playwright 1.64 turned `--update-snapshots=missing` from red to green: with
   * no baseline on disk the test now PASSES, writing `*-expected.png` and
   * `*-actual.png` and setting `config.updateSnapshots`. Nothing annotates it.
   *
   * So a suite can report all-passed while some of its tests compared nothing
   * at all — they recorded a baseline for next time. "Your CI was green, and
   * these 3 tests compared nothing" is the finding a free gate should be known
   * for, and the report already carries every field needed to say it.
   */
  it('names the tests that wrote a baseline instead of comparing one', () => {
    const { gateJson } = runWith('results-baseline-written.json');
    assert.equal(gateJson.updateSnapshots, 'missing', 'the mode is reported, from config');
    assert.deepEqual(
      gateJson.baselineWritten,
      ['visual.spec.js \u203a home page looks right'],
      'only the test with an -actual attachment, not its passing sibling',
    );
  });

  it('REVIEWS rather than CLEARS, and does not block by default', () => {
    // A test that compared nothing is not a failure, so BLOCK would be wrong.
    // REVIEW_ARTIFACTS exits 0 in enforce mode unless strict is set — a human
    // decides, which is the right weight for "this proved less than it looks".
    const { gateJson } = runWith('results-baseline-written.json');
    assert.equal(gateJson.verdict, 'REVIEW_ARTIFACTS');
    assert.equal(gateJson.summary.failed, 0, 'nothing actually failed');
    assert.equal(decideExit({ mode: 'enforce', verdict: gateJson.verdict }).exitCode, 0, 'does not block');
    assert.equal(
      decideExit({ mode: 'enforce', strict: 'true', verdict: gateJson.verdict }).exitCode,
      1,
      'and still blocks for anyone who opted into strict',
    );
  });

  it('says it in the summary a human reads', () => {
    const { cwd } = runWith('results-baseline-written.json');
    const md = fs.readFileSync(path.join(cwd, 'certusqa-gate', 'summary.md'), 'utf8');
    assert.match(md, /compared nothing/i);
    assert.match(md, /home page looks right/);
    assert.match(md, /updateSnapshots/);
  });

  it('the DEFAULT mode alone never flags a run — the attachment is the evidence', () => {
    /*
     * This is the regression test for the first cut of this feature, which
     * gated the finding on `config.updateSnapshots` being missing/all/changed.
     *
     * Every real captured report in test/fixtures has
     * `updateSnapshots: "missing"` with a bare `cli.js test` in its argv, on
     * Playwright 1.61.1. It is the resolved DEFAULT, not an opt-in — so that
     * version would have reported every green run as having compared nothing.
     *
     * It also makes 1.64's change more consequential than it reads: a missing
     * baseline became a pass for EVERYONE, not for people who passed a flag.
     */
    const { gateJson } = runWith('results-all-pass.json');
    assert.equal(gateJson.updateSnapshots, 'missing', 'the default really is set in a real report');
    assert.deepEqual(gateJson.baselineWritten, [], 'and no test carries a -actual attachment');
    assert.equal(gateJson.verdict, 'CLEAR_TO_DEPLOY', 'so a green run stays green');
  });

  it('reports the finding even when the mode field is absent', () => {
    /*
     * The mode is context, not the trigger. An older report may carry no such
     * field at all, and a passing test with a `*-actual` attachment is still
     * evidence that a baseline was written rather than compared — Playwright
     * attaches expected/actual on a comparison FAILURE, so on a pass it is the
     * write.
     */
    const { cwd } = runWith('results-baseline-written.json');
    const file = path.join(cwd, 'test-results', 'results.json');
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete rep.config.updateSnapshots;
    fs.writeFileSync(file, JSON.stringify(rep));
    const again = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'test-results' }), cwd);
    gate.writeOutputs(again);
    const md = fs.readFileSync(path.join(cwd, 'certusqa-gate', 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /updateSnapshots: null/, 'the summary never prints a null mode');
    assert.match(md, /baseline was written rather than compared/);
    assert.equal(again.gate.updateSnapshots, null, 'no mode to report');
    assert.deepEqual(again.gate.baselineWritten, ['visual.spec.js \u203a home page looks right']);
    assert.equal(again.gate.verdict, 'REVIEW_ARTIFACTS', 'the finding stands on the attachment alone');
  });
});

describe('G3/G4 — a CLEAR has to say what it cleared, and a shuffle has to be reproducible', () => {
  it('G3 names the projects that were configured but not run', () => {
    // `filteredProjects` is new in 1.64: what the run actually executed, where
    // `projects` is what the config declared. A verdict that covers one
    // browser should not read like it covered three.
    const { gateJson } = runWith('results-1_64-config.json');
    assert.deepEqual(gateJson.projectsConfigured, ['chromium', 'firefox', 'webkit']);
    assert.deepEqual(gateJson.projectsRun, ['chromium']);
    assert.deepEqual(gateJson.projectsNotRun, ['firefox', 'webkit']);
  });

  it('G3 is informational — it does not change the verdict', () => {
    // `default: false` on a project is a legitimate choice, not a defect. This
    // run is REVIEW because a test retried, and would be whatever it would be
    // either way.
    const { gateJson } = runWith('results-1_64-config.json');
    assert.equal(gateJson.verdict, 'REVIEW_ARTIFACTS', 'the retry is the reason');
    assert.equal(gateJson.summary.flaky, 1);
  });

  it('G3 stays quiet on a report with no filteredProjects', () => {
    // Every pre-1.64 report lacks the field. Absent is not "nothing ran".
    const { gateJson } = runWith('results-all-pass.json');
    assert.deepEqual(gateJson.projectsNotRun, []);
    assert.equal(gateJson.projectsRun, null, 'unknown, not an empty list');
  });

  it('G4 reports the shuffle seed so a shuffled run can be reproduced', () => {
    const { gateJson } = runWith('results-1_64-config.json');
    assert.equal(gateJson.shuffleSeed, 42);
  });

  it('G4 never copies argv into the output — it holds absolute runner paths', () => {
    /*
     * The seed is taken from `config.metadata.shuffleSeed`, which is where
     * 1.64 hands it to reporters. argv is deliberately not echoed: the fixture's
     * own argv contains an absolute home-directory path, and this report is
     * published as evidence.
     */
    const { cwd, gateJson } = runWith('results-1_64-config.json');
    const written = JSON.stringify(gateJson);
    assert.doesNotMatch(written, /\/Users\//, 'no absolute path reaches gate.json');
    assert.doesNotMatch(written, /node_modules/, 'nor a runner path');
    assert.ok(!('argv' in gateJson), 'argv is never a field');
    const md = fs.readFileSync(path.join(cwd, 'certusqa-gate', 'summary.md'), 'utf8');
    assert.doesNotMatch(md, /\/Users\//, 'nor does the summary leak one');
    assert.match(md, /shuffle seed `42`/, 'but the seed itself is printed');
  });

  it('G4 omits the seed when the run was not shuffled', () => {
    const { gateJson } = runWith('results-all-pass.json');
    assert.equal(gateJson.shuffleSeed, null);
  });

  it('the summary names the unrun projects for a human', () => {
    const { cwd } = runWith('results-1_64-config.json');
    const md = fs.readFileSync(path.join(cwd, 'certusqa-gate', 'summary.md'), 'utf8');
    assert.match(md, /configured, not run/i);
    assert.match(md, /firefox/);
    assert.match(md, /webkit/);
  });
});
