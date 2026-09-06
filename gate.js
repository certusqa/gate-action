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
 *   GATE_MEDIA_DIR   dir scanned for png/webm/zip  default test-results
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
 * Walk the Playwright JSON reporter tree.
 * test.status is the reporter's own verdict: expected | unexpected | flaky | skipped.
 * @param {object} report
 */
function summarize(report) {
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
  /** @type {object[]} */
  const cases = [];

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
        };
        if (status === 'expected') counts.passed += 1;
        else if (status === 'skipped') counts.skipped += 1;
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
  return { ...counts, total, cases };
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
      else if (/\.(png|webm|zip)$/i.test(ent.name)) out.push(path.relative(root, full));
    }
  })(dir);
  return out.sort();
}

/**
 * @param {{ status: string }} loaded
 * @param {{ failed: number, flaky: number, total: number }|null} summary
 * @param {string[]} media
 * @returns {string}
 */
function decide(loaded, summary, media) {
  if (loaded.status !== 'parsed' || !summary) return 'INSUFFICIENT_EVIDENCE';
  if (summary.total === 0) return 'INSUFFICIENT_EVIDENCE';
  if (summary.failed > 0) return 'BLOCK_DEPLOY';
  if (summary.flaky > 0 || media.length > 0) return 'REVIEW_ARTIFACTS';
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
 */
function renderSummary(gate, artifacts) {
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
  if (gate.media.length) lines.push(`${gate.media.length} failure media file(s) under \`${gate.mediaDir}\`.`, '');
  lines.push(`Evidence: \`${gate.outputDirRelative}/gate.json\`, \`proof/*.json\`. Classification of each failure as regression, flake or test defect is the CertusQA judge's job, not this action's.`);
  return `${lines.join('\n')}\n`;
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
  const verdict = decide(loaded, summary, media);

  let note = null;
  if (loaded.status === 'absent') {
    note = `No report at ${path.relative(cwd, resultsPath)}. Add reporter: [["json", { outputFile: "${opts.results}" }]] to playwright.config, or set the results input.`;
  } else if (loaded.status === 'unparseable') {
    note = `Report at ${path.relative(cwd, resultsPath)} could not be parsed (${loaded.error}). A corrupt or half-written report is not a green run.`;
  } else if (summary && summary.total === 0) {
    note = 'The report parsed but contains no tests. Nothing ran, so nothing is proven.';
  }

  const artifacts = summary ? summary.cases.map((c) => proofArtifact(c, verdict, opts.mode, media)) : [];

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
    media,
    mediaDir: path.relative(cwd, mediaDir) || '.',
    outputDirRelative: path.relative(cwd, outputDir) || '.',
  };

  return { gate, artifacts, outputDir, summaryMarkdown: renderSummary(gate, artifacts) };
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

module.exports = { VERDICTS, readOptions, loadReport, sanitizeError, summarize, listMedia, decide, proofArtifact, renderSummary, run, writeOutputs };

if (require.main === module) main().catch((err) => { console.error(`certusqa-gate: ${err && err.stack ? err.stack : err}`); process.exit(1); });
