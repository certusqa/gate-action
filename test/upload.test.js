'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const gate = require('../gate.js');
const up = require('../upload.js');

const FIX = path.join(__dirname, 'fixtures');
const SECRET = 'cqa_live_' + 'k'.repeat(40);

/** Independent re-derivation with node:crypto, so the test does not trust upload.js's own crypto. */
function expectedHmac(secret, message) {
  const hmacKey = crypto.hkdfSync('sha256', secret, 'certusqa-v1', 'hmac', 32);
  return crypto.createHmac('sha256', Buffer.from(hmacKey)).update(message, 'utf8').digest('hex');
}

function evidenceDir(fixture) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'certusqa-upload-'));
  fs.mkdirSync(path.join(cwd, 'test-results'), { recursive: true });
  fs.copyFileSync(path.join(FIX, fixture), path.join(cwd, 'test-results', 'results.json'));
  const r = gate.run(gate.readOptions({ GATE_RESULTS: 'test-results/results.json', GATE_MEDIA_DIR: 'none', GATE_OUTPUT_DIR: 'certusqa-gate' }), cwd);
  gate.writeOutputs(r);
  return path.join(cwd, 'certusqa-gate');
}

const GH = { GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abcdef1234567890', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'e2e', GITHUB_REF: 'refs/pull/7/merge', GITHUB_REF_NAME: '7/merge', GITHUB_WORKFLOW: 'E2E' };

describe('signing matches the platform contract', () => {
  it('derives the HMAC key with HKDF(salt certusqa-v1, info hmac) and signs both headers', async () => {
    const body = '{"a":1}';
    const h = await up.signRequest(body, SECRET, 1757164800);
    assert.equal(h.Authorization, `Bearer ${SECRET}`);
    assert.equal(h['X-CertusQA-Signature'], `sha256=${expectedHmac(SECRET, body)}`);
    assert.equal(h['X-CertusQA-Signature-Versioned'], `t=1757164800,v1=${expectedHmac(SECRET, `1757164800.${body}`)}`);
  });
});

describe('payload', () => {
  it('is schema 2.0.0 built from gate.json and proof/*.json with the GitHub context as externalRef', () => {
    const dir = evidenceDir('results-mixed.json');
    const { gate: g, artifacts } = up.readEvidence(dir);
    const { payload } = up.buildPayload(g, artifacts, GH);
    assert.equal(payload.schemaVersion, '2.0.0');
    assert.deepEqual(payload.source, { tool: 'gate-action', version: up.ACTION_VERSION });
    assert.deepEqual(payload.externalRef, { provider: 'github', repo: 'acme/app', sha: 'abcdef1234567890', runId: 42, runAttempt: 1, prNumber: 7, ref: '7/merge', workflow: 'E2E' });
    assert.equal(payload.gate.verdict, 'BLOCK_DEPLOY');
    assert.deepEqual(payload.gate.summary, { passed: 1, failed: 1, flaky: 1, skipped: 1, total: 4 });
    assert.equal(payload.artifacts.length, 2);
    for (const a of payload.artifacts) {
      assert.equal(a.artifactType, 'PROOF_ARTIFACT');
      assert.ok(['NEEDS_TRIAGE', 'FLAKY'].includes(a.classification.category));
      assert.equal(typeof a.summary, 'string');
    }
  });

  it('refuses to build a reference outside GitHub Actions instead of inventing one', () => {
    const dir = evidenceDir('results-all-pass.json');
    const { gate: g, artifacts } = up.readEvidence(dir);
    const { payload, reason } = up.buildPayload(g, artifacts, {});
    assert.equal(payload, null);
    assert.match(reason, /GITHUB_REPOSITORY and GITHUB_SHA/);
  });
});

describe('api-key normalisation — say what is wrong before sending', () => {
  it('accepts a raw key, and one pasted with quotes or whitespace', () => {
    assert.deepEqual(up.normaliseApiKey(SECRET), { ok: true, value: SECRET });
    assert.deepEqual(up.normaliseApiKey(`  "${SECRET}"\n`), { ok: true, value: SECRET });
    assert.deepEqual(up.normaliseApiKey(JSON.stringify({ key: { id: 'key_1' }, secret: SECRET, shown_once: true })), { ok: true, value: SECRET });
  });
  it('names the mistake for a key id, a JSON blob without a secret, or garbage', () => {
    assert.match(up.normaliseApiKey('key_abc123').reason, /key id/);
    assert.match(up.normaliseApiKey('{"foo":1}').reason, /JSON object/);
    assert.match(up.normaliseApiKey('hunter2').reason, /does not look like a CertusQA key/);
    assert.match(up.normaliseApiKey('').reason, /empty/);
  });
});

describe('upload against a stub platform', () => {
  let server;
  let received = [];
  let respond = () => ({ status: 201, body: { run_id: 'run_test1', verdict: 'BLOCK_DEPLOY', artifacts: 2, sanitised_server_side: false, url: 'https://app.certusqa.com/app/runs/run_test1' } });
  let url;

  before(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body: data });
        const r = respond(req, data);
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/api/v1/runs`;
  });
  after(() => {
    // fetch keeps its socket alive; close() alone would wait on it and hang the runner.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  });

  it('POSTs a signed, idempotent request and returns the run id and url', async () => {
    received = [];
    const dir = evidenceDir('results-mixed.json');
    const out = await up.upload({ outputDir: dir, apiKey: SECRET, apiUrl: url, env: GH, nowSec: 1757164800 });
    assert.deepEqual(out, { ok: true, status: 201, runId: 'run_test1', url: 'https://app.certusqa.com/app/runs/run_test1', replayed: false, sanitisedServerSide: false });
    assert.equal(received.length, 1);
    const r = received[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(r.headers['idempotency-key'], 'gh-42-1-e2e');
    assert.equal(r.headers['x-certusqa-signature'], `sha256=${expectedHmac(SECRET, r.body)}`);
    assert.equal(r.headers['x-certusqa-signature-versioned'], `t=1757164800,v1=${expectedHmac(SECRET, `1757164800.${r.body}`)}`);
    const sent = JSON.parse(r.body);
    assert.equal(sent.gate.verdict, 'BLOCK_DEPLOY');
    assert.equal(sent.artifacts.length, 2);
    assert.ok(!r.body.includes('\u001b'), 'no ANSI in what is sent');
  });

  it('a refusal is a warning with the platform error, never a throw', async () => {
    respond = () => ({ status: 402, body: { error: 'plan_limit_reached', detail: ['50/50 runs this month on plan free'] } });
    const out = await up.upload({ outputDir: evidenceDir('results-all-pass.json'), apiKey: SECRET, apiUrl: url, env: GH });
    assert.equal(out.ok, false);
    assert.equal(out.status, 402);
    assert.match(out.warning, /plan_limit_reached \(50\/50/);
    respond = () => ({ status: 201, body: { run_id: 'run_test1', url: 'u' }, headers: { 'Idempotent-Replayed': 'true' } });
    const replay = await up.upload({ outputDir: evidenceDir('results-all-pass.json'), apiKey: SECRET, apiUrl: url, env: GH });
    assert.equal(replay.replayed, true);
  });

  it('a network failure is a warning, never a throw', async () => {
    const out = await up.upload({ outputDir: evidenceDir('results-all-pass.json'), apiKey: SECRET, apiUrl: 'http://127.0.0.1:1/api/v1/runs', env: GH });
    assert.equal(out.ok, false);
    assert.match(out.warning, /upload failed/);
  });

  it('does not upload when the GitHub context is missing', async () => {
    received = [];
    const out = await up.upload({ outputDir: evidenceDir('results-all-pass.json'), apiKey: SECRET, apiUrl: url, env: {} });
    assert.equal(out.ok, false);
    assert.match(out.warning, /not uploaded/);
    assert.equal(received.length, 0);
  });
});
