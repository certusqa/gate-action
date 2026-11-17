#!/usr/bin/env node
'use strict';

/**
 * CertusQA Gate — verdict, Proof Artifacts and summary from a Playwright JSON report.
 *
 * No dependencies. Runs as the first step of the composite action and, by design,
 * never exits non-zero on a verdict: the evidence must be written and uploaded
 * before anything goes red. enforce.js does the failing, last.
 *
 * Four verdicts, and the reason each exists:
 *   CLEAR_TO_DEPLOY        every test passed first time, no failure media on disk
 *   REVIEW_ARTIFACTS       something passed only on retry, or failure media exists —
 *                          a human decides; it is not an automatic pass
 *   BLOCK_DEPLOY           at least one test failed after its retries
 *   INSUFFICIENT_EVIDENCE  the report is absent, unreadable or has no tests.
 *                          Never treat a missing report as green.
 *
 * Every failure and every flaky test becomes a Proof Artifact file in the same
 * shape the CertusQA engine emits, with classification NEEDS_TRIAGE / INCONCLUSIVE
 * and failKind "unjudged": this action records; the judge that says "regression"
 * or "flake" is the paid, hosted part.
 *
 * Environment (set by action.yml from the inputs):
 *   GATE_RESULTS     path to results.json          default test-results/results.json
 *   GATE_MEDIA_DIR   dir scanned for png/webp/webm/zip  default test-results
 *   GATE_MODE        report-only | enforce         default report-only
 *   GATE_STRICT      "true" to make REVIEW block   default false
 *   GATE_OUTPUT_DIR  where to write                default certusqa-gate
 * Also honours GITHUB_OUTPUT and GITHUB_STEP_SUMMARY when present.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0.0';
const PROOF_SCHEMA_VERSION = '1.1.0';
const ERROR_MESSAGE_MAX = 400;
const SKIP_REASON_MAX = 160;
/** At most this many skipped tests are listed by name; the rest are counted. */
const SKIPPED_LISTED_MAX = 20;
const VERDICTS = ['CLEAR_TO_DEPLOY', 'REVIEW_ARTIFACTS', 'BLOCK_DEPLOY', 'INSUFFICIENT_EVIDENCE'];

/**
 * @param {Record<string, string|undefined>} env
 */
function readOptions(env) {
  const mode = env.GATE_MODE === 'enforce' ? 'enforce' : 'report-only';
  return {
    results: env.GATE_RESULTS || 'test-results/results.json',
    mediaDir: env.GATE_MEDIA_DIR || 'test-results',
    mode,
    strict: String(env.GATE_STRICT || '').toLowerCase() === 'true',
    outputDir: env.GATE_OUTPUT_DIR || 'certusqa-gate',
  };
}

/**
 * Three states — never treat an unreadable file as "no report".
 * @param {string} file
 * @returns {{ status: 'parsed'|'absent'|'unparseable', report: object|null, error?: string }}
 */
function loadReport(file) {
  if (!fs.existsSync(file)) return { status: 'absent', report: null };
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!report || typeof report !== 'object') return { status: 'unparseable', report: null, error: 'not a JSON object' };
    return { status: 'parsed', report };
  } catch (err) {
    return { status: 'unparseable', report: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Strip ANSI colour, drop Playwright's "Received" value blocks (page text a
 * customer may not want in an artifact), collapse whitespace, cap length.
 * @param {unknown} message
 * @returns {string|null}
 */
function sanitizeError(message) {
  if (message == null) return null;
  let text = String(message)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\n\s*Received(?:\s+(?:string|number|object|value))?:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > ERROR_MESSAGE_MAX) text = `${text.slice(0, ERROR_MESSAGE_MAX)}…`;
  return text || null;
}

/**
 * The reason a skipped test gives: the description of its `skip` or `fixme`
 * annotation, test-level first, then the last result's. Sanitised like an
 * error message and shorter. Null when the author gave none (a bare
 * `test.skip()`, or a test skipped because its serial group failed).
 * @param {{ annotations?: unknown }} t
 * @param {Array<{ annotations?: unknown }>} results
 * @returns {string|null}
 */
function skipReason(t, results) {
  const last = results[results.length - 1] || {};
  for (const list of [t.annotations, last.annotations]) {
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || (a.type !== 'skip' && a.type !== 'fixme')) continue;
      const text = sanitizeError(a.description);
      if (text) return text.length > SKIP_REASON_MAX ? `${text.slice(0, SKIP_REASON_MAX)}…` : text;
    }
  }
  return null;
}

/**
 * Walk the Playwright JSON reporter tree.
 * test.status is the reporter's own verdict: expected | unexpected | flaky | skipped.
 * @param {object} report
 */
function summarize(report) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  /** @type {object[]} */
  const cases = [];
  /*
   * Titles of PASSING tests that carry a `*-actual.*` attachment.
   *
   * Playwright 1.64 made `--update-snapshots=missing` pass with no baseline on
   * disk: the test writes `*-expected` and `*-actual` and reports `expected`.
   * Nothing annotates it, so a suite can be all-green while some of its tests
   * compared nothing and merely recorded a baseline for next time.
   *
   * Collected unconditionally here and only REPORTED when
   * `config.updateSnapshots` is set, because without that field a `*-actual`
   * attachment on a passing test proves nothing — and every report from an
   * older Playwright lacks the field entirely.
   */
  /** @type {string[]} */
  const baselineWritten = [];
  /*
   * Skipped tests and the reason their author gave. Playwright 1.65 made
   * `test.skip('reason')` official and records the description as an
   * annotation, so a CLEAR can say WHICH tests it did not run and why, not
   * just how many. Only the description is read: an annotation also carries
   * `location.file`, an absolute runner path, which never reaches an output.
   * Rendered in the summary only; gate.json keeps its schema.
   */
  /** @type {Array<{title: string, reason: string|null}>} */
  const skippedTests = [];

  function walk(suite, trail) {
    const here = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const results = Array.isArray(t.results) ? t.results : [];
        const last = results[results.length - 1] || {};
        const status = t.status || 'unknown';
        const entry = {
          title: [...here.filter((s) => s !== spec.file), spec.title].join(' › '),
          file: spec.file || null,
          line: spec.line || null,
          project: t.projectName || null,
          status,
          attempts: results.map((r) => r.status),
          error: sanitizeError((last.error && last.error.message) || (results.find((r) => r.error) || {}).error?.message || null),
          durationMs: results.reduce((a, r) => a + (Number(r.duration) || 0), 0),
          // Paths this result REFERENCES. Already in the report, and the only
          // authoritative link between a file on disk and the test that
          // produced it - see the `related` heuristic in proofArtifact.
          attachments: results.flatMap((r) =>
            (Array.isArray(r.attachments) ? r.attachments : [])
              .map((a) => a && a.path)
              .filter((pth) => typeof pth === 'string' && pth),
          ),
        };
        if (status === 'expected') {
          counts.passed += 1;
          if (entry.attachments.some((pth) => /-actual\.[^./\\]+$/i.test(pth))) baselineWritten.push(entry.title);
        }
        else if (status === 'skipped') {
          counts.skipped += 1;
          skippedTests.push({ title: entry.title, reason: skipReason(t, results) });
        }
        else if (status === 'flaky') {
          counts.flaky += 1;
          entry.error = sanitizeError((results.find((r) => r.error) || {}).error?.message || null);
          cases.push(entry);
        } else {
          counts.failed += 1;
          cases.push(entry);
        }
      }
    }
    for (const child of suite.suites || []) walk(child, here);
  }
  for (const s of report.suites || []) walk(s, []);
  const total = counts.passed + counts.failed + counts.flaky + counts.skipped;
  return { ...counts, total, cases, baselineWritten, skippedTests };
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {string[]} repo-relative paths of failure media
 */
function listMedia(dir, root) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(png|webp|webm|zip)$/i.test(ent.name)) out.push(path.relative(root, full));
    }
  })(dir);
  return out.sort();
}

/**
 * @param {{ status: string }} loaded
 * @param {{ failed: number, flaky: number, total: number }|null} summary
 * @param {string[]} failureMedia media referenced by a failed or flaky result
 * @param {string[]} [baselineWritten] passing tests that wrote a baseline rather than comparing one
 * @returns {string}
 */
function decide(loaded, summary, failureMedia, baselineWritten = []) {
  if (loaded.status !== 'parsed' || !summary) return 'INSUFFICIENT_EVIDENCE';
  if (summary.total === 0) return 'INSUFFICIENT_EVIDENCE';
  if (summary.failed > 0) return 'BLOCK_DEPLOY';
  /*
   * `failureMedia` is media a FAILED or FLAKY result referenced, not every
   * file under the media dir. This parameter used to be the whole directory
   * listing, so a leftover screenshot from an earlier run returned
   * REVIEW_ARTIFACTS - and under GATE_STRICT a REVIEW blocks, so a clean run
   * was blocked by somebody else's debris. Playwright 1.64 makes
   * `video: 'on'` ordinary, which turns that from an annoyance into every
   * green run carrying a webm.
   *
   * In practice this list is empty whenever it could matter: a failure already
   * returned BLOCK above, a retry returns REVIEW on the line below, so the only
   * run whose verdict media could decide is one where everything passed - and
   * such a run has no failed or flaky result to reference anything. It stays a
   * parameter because that argument is about today's verdict ladder, not about
   * what the gate means.
   */
  if (summary.flaky > 0 || failureMedia.length > 0) return 'REVIEW_ARTIFACTS';
  // A test that wrote a baseline instead of comparing one did not fail, so
  // BLOCK would be wrong — but it proved less than a green tick implies, and
  // REVIEW_ARTIFACTS exits 0 in enforce mode unless the operator set strict.
  // That is the right weight: a human decides.
  if (baselineWritten.length > 0) return 'REVIEW_ARTIFACTS';
  return 'CLEAR_TO_DEPLOY';
}

/**
 * @param {object} c a case from summarize()
 * @param {string} verdict
 * @param {string} mode
 * @param {string[]} media
 */
function proofArtifact(c, verdict, mode, media) {
  const isFlaky = c.status === 'flaky';
  const seed = `${c.file}:${c.line}:${c.title}:${c.project || ''}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const slug = (c.title || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const related = media.filter((m) => slug && m.toLowerCase().includes(slug.split('-').slice(-2).join('-')));
  return {
    schemaVersion: PROOF_SCHEMA_VERSION,
    artifactType: 'PROOF_ARTIFACT',
    id: `pa_${isFlaky ? 'flaky' : 'unjudged'}_${hash}`,
    summary: isFlaky
      ? `Passed only on retry: ${c.title}`
      : `Failed after ${c.attempts.length} attempt(s): ${c.title}`,
    classification: {
      category: isFlaky ? 'FLAKY' : 'NEEDS_TRIAGE',
      severity: isFlaky ? 'LOW' : 'HIGH',
      outcome: 'INCONCLUSIVE',
      failKind: 'unjudged',
    },
    rootCause: {
      statement: isFlaky
        ? 'The test failed and then passed on retry. Whether that is a timing race in the test or an intermittent defect in the application is not decided here.'
        : 'The test failed on every attempt. Whether the application regressed or the test is at fault is not decided here.',
      signals: [
        `attempts=${c.attempts.join(',')}`,
        c.error ? `error=${c.error}` : 'error=none-recorded',
        c.file ? `spec=${c.file}${c.line ? `:${c.line}` : ''}` : 'spec=unknown',
      ],
    },
    remediation: {
      recommendation: isFlaky
        ? 'Review the retry. Do not raise the timeout or add a retry to make it go away; find what changed between attempts.'
        : 'Triage against the last known-good run. Do not loosen the assertion until the expected value is confirmed.',
      confidence: 'none',
      ownerHint: 'unknown',
      note: 'Classification (regression vs flake vs test defect) is produced by the CertusQA judge, not by this action.',
    },
    evidence: {
      test: { title: c.title, file: c.file, line: c.line, project: c.project },
      attempts: c.attempts,
      error: c.error,
      media: related,
      durationMs: c.durationMs,
    },
    gate: { verdict, mode },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * @param {object} gate
 * @param {object[]} artifacts
 * @param {{ skippedTests?: Array<{title: string, reason: string|null}> }} [extras] summary-only detail, not in gate.json
 */
function renderSummary(gate, artifacts, extras = {}) {
  const s = gate.summary;
  const icon = { CLEAR_TO_DEPLOY: '🟢', REVIEW_ARTIFACTS: '🟡', BLOCK_DEPLOY: '🔴', INSUFFICIENT_EVIDENCE: '⚪' }[gate.verdict];
  const lines = [];
  lines.push(`## ${icon} CertusQA Gate: \`${gate.verdict}\``);
  lines.push('');
  lines.push(`Mode **${gate.mode}**${gate.mode === 'report-only' ? ' (recorded, not enforced)' : gate.strict ? ' (strict)' : ''} · report ${gate.reportStatus}${gate.reportPath ? ` · \`${gate.reportPath}\`` : ''}`);
  lines.push('');
  if (gate.reportStatus === 'parsed') {
    lines.push('| Passed | Failed | Flaky | Skipped | Total |');
    lines.push('|---:|---:|---:|---:|---:|');
    lines.push(`| ${s.passed} | ${s.failed} | ${s.flaky} | ${s.skipped} | ${s.total} |`);
    lines.push('');
  }
  // Directly under the counts, because it qualifies them: a verdict that
  // covered one browser must not read as though it covered three. Placed above
  // the failure table so it cannot be skimmed past.
  if (gate.projectsNotRun && gate.projectsNotRun.length) {
    lines.push(
      `**Configured, not run:** ${gate.projectsNotRun.join(', ')} — this verdict covers ${(gate.projectsRun || []).join(', ') || 'the default project'} only.`,
      '',
    );
  }
  // Under the counts, because it qualifies the Skipped column: which tests, and why.
  const skipped = Array.isArray(extras && extras.skippedTests) ? extras.skippedTests : [];
  if (skipped.length) {
    lines.push(`**Skipped (${skipped.length}):**`, '');
    for (const sk of skipped.slice(0, SKIPPED_LISTED_MAX)) {
      lines.push(`- ${sk.title} — ${sk.reason ? sk.reason : 'no reason given'}`);
    }
    if (skipped.length > SKIPPED_LISTED_MAX) lines.push(`- …and ${skipped.length - SKIPPED_LISTED_MAX} more`);
    lines.push('');
  }
  if (gate.note) lines.push(`> ${gate.note}`, '');
  if (artifacts.length) {
    lines.push('| Proof Artifact | Test | Attempts | Error |');
    lines.push('|---|---|---|---|');
    for (const a of artifacts) {
      const e = a.evidence;
      lines.push(`| \`${a.id}\` | ${e.test.title}${e.test.file ? ` (\`${e.test.file}${e.test.line ? `:${e.test.line}` : ''}\`)` : ''} | ${e.attempts.join(' → ')} | ${e.error ? e.error.replace(/\|/g, '\\|').slice(0, 160) : ''} |`);
    }
    lines.push('');
  }
  if (typeof gate.shuffleSeed === 'string' && gate.shuffleSeed) {
    lines.push(`Test order was shuffled: re-run with \`--shuffle ${gate.shuffleSeed}\` to reproduce it (shuffle seed \`${gate.shuffleSeed}\`).`, '');
  }
  if (gate.baselineWritten && gate.baselineWritten.length) {
    lines.push(
      `### ${gate.baselineWritten.length} test(s) compared nothing`,
      '',
      gate.updateSnapshots
        ? `The run used \`updateSnapshots: ${gate.updateSnapshots}\`, in which a baseline that was not on disk is written rather than failed (since Playwright 1.64; left unset, the mode is \`default\` and the test fails). These tests passed without comparing anything — they recorded a baseline for next time:`
        : 'These tests passed carrying a `*-actual` attachment, which means a baseline was written rather than compared. They proved nothing about what they were meant to check:',
      '',
      ...gate.baselineWritten.map((t) => `- ${t}`),
      '',
      'Re-run them once the baselines are committed, or they will keep passing on their own output.',
      '',
    );
  }
  // Named apart on purpose: calling every file "failure media" is what made a
  // green run look like it needed review.
  if (gate.failureMedia && gate.failureMedia.length) {
    lines.push(`${gate.failureMedia.length} failure media file(s) under \`${gate.mediaDir}\`, referenced by a failed or flaky test.`, '');
  }
  if (gate.recordedMedia && gate.recordedMedia.length) {
    lines.push(`${gate.recordedMedia.length} further media file(s) under \`${gate.mediaDir}\` were recorded, not failure evidence.`, '');
  }
  lines.push(`Evidence: \`${gate.outputDirRelative}/gate.json\`, \`proof/*.json\`. Classification of each failure as regression, flake or test defect is the CertusQA judge's job, not this action's.`);
  return `${lines.join('\n')}\n`;
}

/**
 * Which files on disk a failed or flaky result actually points at.
 *
 * Attachment paths come from the runner and may be absolute; anything that
 * resolves outside `cwd` is dropped rather than guessed at.
 *
 * @param {{cases: object[]}|null} summary
 * @param {string[]} media repo-relative paths from listMedia
 * @param {string} cwd
 * @returns {Set<string>}
 */
function referencedMedia(summary, media, cwd) {
  const out = new Set();
  if (!summary || !Array.isArray(summary.cases)) return out;
  const known = new Set(media);
  for (const c of summary.cases) {
    for (const raw of Array.isArray(c.attachments) ? c.attachments : []) {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      const rel = path.relative(cwd, abs);
      if (!rel || rel.startsWith('..')) continue;
      if (known.has(rel)) out.add(rel);
    }
  }
  return out;
}

/**
 * Project names from a config list, dropping the unnamed default.
 * @param {unknown} list
 * @returns {string[]|null} null when the field is absent entirely
 */
function projectNames(list) {
  if (!Array.isArray(list)) return null;
  return list.map((p) => (p && typeof p.name === 'string' ? p.name : '')).filter(Boolean);
}

/**
 * The shuffle seed, for reproducing a shuffled run.
 *
 * Read from `config.metadata.shuffleSeed`, which is where 1.64 hands it to
 * reporters — not by parsing `config.argv`. argv carries the seed only when it
 * was passed explicitly, and it also carries absolute runner paths, so it is
 * never read into anything this action publishes.
 *
 * The seed is a STRING, and is kept as one. Playwright 1.64.0 and 1.65.1 both
 * write `"shuffleSeed": "42"`, for an explicit `--shuffle 42` and for a random
 * seed alike, and `--shuffle abc` is accepted too. The order is
 * `sha1(seed + testId)`, so `"007"` and `"7"` are different orders: turning the
 * seed into a number would print a seed that does not reproduce the run. The
 * first cut of this function accepted only a number, matched a hand-written
 * fixture, and so printed nothing for every real report.
 *
 * Only a short seed of letters, digits, `.`, `_` and `-` is echoed, because it
 * lands in Markdown inside backticks. Anything else is dropped rather than
 * escaped into something that would not reproduce the run either.
 *
 * @param {object|null} config
 * @returns {string|null}
 */
function shuffleSeedOf(config) {
  const raw = config && config.metadata && config.metadata.shuffleSeed;
  // A number never comes from a real reporter, but a hand-built report may carry one.
  const seed = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  return typeof seed === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(seed) ? seed : null;
}

/**
 * Whether the config declares the built-in json reporter with `onlyFailures`
 * (new in Playwright 1.65). Read from `config.reporter`, which the json
 * reporter serialises as `[name, options]` pairs. The env-variable form,
 * PLAYWRIGHT_JSON_ONLY_FAILURES, is not recorded there and cannot be seen.
 *
 * @param {object|null} config
 * @returns {boolean}
 */
function jsonOnlyFailures(config) {
  const list = config && Array.isArray(config.reporter) ? config.reporter : [];
  return list.some((r) => Array.isArray(r) && r[0] === 'json' && !!r[1] && r[1].onlyFailures === true);
}

/**
 * @param {ReturnType<typeof readOptions>} opts
 * @param {string} cwd
 */
function run(opts, cwd) {
  const resultsPath = path.resolve(cwd, opts.results);
  const mediaDir = path.resolve(cwd, opts.mediaDir);
  const outputDir = path.resolve(cwd, opts.outputDir);
  const loaded = loadReport(resultsPath);
  const summary = loaded.status === 'parsed' ? summarize(loaded.report) : null;
  const media = listMedia(mediaDir, cwd);
  const referenced = referencedMedia(summary, media, cwd);
  const failureMedia = media.filter((m) => referenced.has(m));
  const recordedMedia = media.filter((m) => !referenced.has(m));
  /*
   * `updateSnapshots` is CONTEXT, not the trigger.
   *
   * The first cut of this gated the finding on the mode being one of
   * missing/all/changed — and every 1.61.1 report in test/fixtures has
   * `updateSnapshots: "missing"` with no flag in its `argv`: before 1.64 that
   * was the resolved default, so gating on it would have flagged every run.
   *
   * A correction (2026-11-17, measured on 1.64.0 and 1.65.1): 1.64 split the
   * two. An unset mode now serialises as `"default"` and still FAILS a missing
   * baseline (`test/fixtures/results-1_65-snapshot-default-mode.json`); only an
   * explicit `missing` passes one (`results-1_65-snapshot-missing-mode.json`).
   * This comment used to say 1.64's change applied to everyone by default. It
   * applies to everyone who sets `missing`, which is what teams do to generate
   * and verify baselines in one CI run.
   *
   * The evidence is the attachment. A PASSING test carrying `*-actual.*` means
   * a baseline was written rather than compared — Playwright attaches
   * expected/actual on a comparison FAILURE, so on a pass it is the write.
   * The mode is reported beside it because it explains why the test passed.
   */
  const config = (loaded.report && loaded.report.config) || null;
  /*
   * What the config declared, versus what the run actually executed.
   * `filteredProjects` is new in 1.64; every earlier report lacks it, and
   * absent must not read as "nothing ran" — hence null rather than [].
   *
   * Informational only. A `default: false` project is a legitimate choice, not
   * a defect, so this never moves the verdict. But a CLEAR that covered one
   * browser should not read as though it covered three.
   */
  const projectsConfigured = projectNames(config && config.projects) || [];
  const projectsRun = projectNames(config && config.filteredProjects);
  const projectsNotRun = projectsRun ? projectsConfigured.filter((n) => !projectsRun.includes(n)) : [];
  const shuffleSeed = shuffleSeedOf(config);

  const rawMode = loaded.report && loaded.report.config && loaded.report.config.updateSnapshots;
  const updateSnapshots = typeof rawMode === 'string' && rawMode ? rawMode : null;
  const baselineWritten = summary ? summary.baselineWritten : [];
  const verdict = decide(loaded, summary, failureMedia, baselineWritten);
  const onlyFailures = jsonOnlyFailures(config);

  let note = null;
  if (loaded.status === 'absent') {
    note = `No report at ${path.relative(cwd, resultsPath)}. Add reporter: [["json", { outputFile: "${opts.results}" }]] to playwright.config, run Playwright 1.63+ with --add-reporter json and PLAYWRIGHT_JSON_OUTPUT_FILE=${opts.results}, or set the results input.`;
  } else if (loaded.status === 'unparseable') {
    note = `Report at ${path.relative(cwd, resultsPath)} could not be parsed (${loaded.error}). A corrupt or half-written report is not a green run.`;
  } else if (summary && summary.total === 0) {
    /*
     * Since 1.65 an empty report does not mean nothing ran. The json reporter's
     * `onlyFailures` keeps only unexpected, flaky and interrupted tests, and on
     * a green run it writes `suites: []` with every `stats` count at 0 - the
     * same bytes as a run of nothing. The verdict stays INSUFFICIENT_EVIDENCE
     * either way: a report with the passes left out cannot prove a pass. Only
     * the explanation differs, and the env-variable form
     * (PLAYWRIGHT_JSON_ONLY_FAILURES) leaves no trace in the report, so the
     * fallback names it as a possibility rather than claiming nothing ran.
     */
    note = onlyFailures
      ? 'The report has no tests because its json reporter ran with onlyFailures: true, which leaves passing tests out. Nothing in it proves a pass. Remove onlyFailures from the json reporter the gate reads.'
      : 'The report parsed but contains no tests. Either nothing ran, or the json reporter kept only failures (Playwright 1.65 onlyFailures, or PLAYWRIGHT_JSON_ONLY_FAILURES=1). Either way nothing in it proves a pass.';
  } else if (summary && onlyFailures) {
    note = 'The json reporter ran with onlyFailures: true, so passing tests are not in this report: the counts cover failed and flaky tests only. Remove onlyFailures from the json reporter the gate reads.';
  }

  const artifacts = summary ? summary.cases.map((c) => proofArtifact(c, verdict, opts.mode, media)) : [];
  // Each artifact's media: what its own case referenced, union whatever the
  // directory heuristic in proofArtifact found. Union because each catches
  // what the other misses - attachments are authoritative but a reporter may
  // record none, while the heuristic matches a directory Playwright named
  // after the test.
  if (summary) {
    for (let i = 0; i < artifacts.length; i += 1) {
      const own = [...referencedMedia({ cases: [summary.cases[i]] }, media, cwd)];
      artifacts[i].evidence.media = [...new Set([...own, ...artifacts[i].evidence.media])].sort();
    }
  }

  const gate = {
    schemaVersion: SCHEMA_VERSION,
    product: 'CertusQA Gate',
    generatedAt: new Date().toISOString(),
    mode: opts.mode,
    strict: opts.strict,
    verdict,
    reportStatus: loaded.status,
    reportPath: loaded.status === 'absent' ? null : path.relative(cwd, resultsPath),
    summary: summary
      ? { passed: summary.passed, failed: summary.failed, flaky: summary.flaky, skipped: summary.skipped, total: summary.total }
      : { passed: null, failed: null, flaky: null, skipped: null, total: null },
    note,
    failures: summary ? summary.cases.map((c) => ({ title: c.title, file: c.file, line: c.line, status: c.status, attempts: c.attempts, error: c.error })) : [],
    proofArtifacts: artifacts.map((a) => a.id),
    updateSnapshots,
    baselineWritten,
    projectsConfigured,
    projectsRun,
    projectsNotRun,
    shuffleSeed,
    media,
    failureMedia,
    recordedMedia,
    mediaDir: path.relative(cwd, mediaDir) || '.',
    outputDirRelative: path.relative(cwd, outputDir) || '.',
  };

  return { gate, artifacts, outputDir, summaryMarkdown: renderSummary(gate, artifacts, { skippedTests: summary ? summary.skippedTests : [] }) };
}

/**
 * @param {ReturnType<typeof run>} result
 */
function writeOutputs(result) {
  const { gate, artifacts, outputDir, summaryMarkdown } = result;
  fs.mkdirSync(path.join(outputDir, 'proof'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'gate.json'), `${JSON.stringify(gate, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'summary.md'), summaryMarkdown);
  for (const a of artifacts) fs.writeFileSync(path.join(outputDir, 'proof', `${a.id}.json`), `${JSON.stringify(a, null, 2)}\n`);

  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `verdict=${gate.verdict}`,
      `report-status=${gate.reportStatus}`,
      `passed=${gate.summary.passed ?? ''}`,
      `failed=${gate.summary.failed ?? ''}`,
      `flaky=${gate.summary.flaky ?? ''}`,
      `skipped=${gate.summary.skipped ?? ''}`,
      `output-dir=${outputDir}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown);
}

async function main() {
  const opts = readOptions(process.env);
  const result = run(opts, process.cwd());
  writeOutputs(result);
  const s = result.gate.summary;
  console.log(
    `certusqa-gate: ${result.gate.verdict} (mode ${opts.mode}, report ${result.gate.reportStatus}` +
      (result.gate.reportStatus === 'parsed' ? `, ${s.passed} passed / ${s.failed} failed / ${s.flaky} flaky / ${s.skipped} skipped` : '') +
      `) → ${path.relative(process.cwd(), result.outputDir)}/`,
  );
  if (result.gate.note) console.log(`certusqa-gate: ${result.gate.note}`);

  // Optional, after the evidence is on disk: upload to the platform. Never
  // fails the step — the verdict and the files above are the product; the
  // upload is a copy of them. The key is read here and never logged.
  const apiKey = String(process.env.GATE_API_KEY || '').trim();
  let runId = '';
  let runUrl = '';
  if (apiKey) {
    const { upload } = require('./upload.js');
    const out = await upload({ outputDir: result.outputDir, apiKey, apiUrl: process.env.GATE_API_URL || undefined });
    if (out.ok) {
      runId = out.runId || '';
      runUrl = out.url || '';
      console.log(`certusqa-gate: uploaded as ${runId}${out.replayed ? ' (already recorded for this workflow run)' : ''}${out.sanitisedServerSide ? ' — the platform had to sanitise this payload; check what your reporter emits' : ''}`);
      if (process.env.GITHUB_STEP_SUMMARY && runUrl) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nRecorded on the CertusQA platform: ${runUrl}\n`);
    } else {
      console.log(`::warning title=CertusQA Gate upload::${out.warning}`);
    }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${runId}\nrun-url=${runUrl}\n`);
}

module.exports = { VERDICTS, readOptions, loadReport, sanitizeError, summarize, listMedia, decide, proofArtifact, renderSummary, shuffleSeedOf, run, writeOutputs };

if (require.main === module) main().catch((err) => { console.error(`certusqa-gate: ${err && err.stack ? err.stack : err}`); process.exit(1); });
