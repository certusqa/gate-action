'use strict';

/**
 * Optional upload of the run to the CertusQA platform.
 *
 * Runs only when the `api-key` input is set. Builds the platform's payload
 * (schemaVersion 2.0.0) from the gate.json and Proof Artifacts this action just
 * wrote, signs it, and POSTs it. It never fails the job: the evidence is already
 * on disk and in the workflow artifact; an upload problem is a warning.
 *
 * Signing, so the secret never leaves this runner:
 *   hmacKey  = HKDF-SHA256(secret, salt "certusqa-v1", info "hmac")
 *   headers  = X-CertusQA-Signature-Versioned: t=<unix s>,v1=<HMAC(hmacKey, "<t>.<body>")>
 *              X-CertusQA-Signature:           sha256=<HMAC(hmacKey, body)>
 *   Authorization: Bearer <secret>       (the platform matches sha256(secret))
 *
 * Node built-ins only (webcrypto + global fetch).
 */

const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const ACTION_VERSION = '1.0.0';
const DEFAULT_URL = 'https://app.certusqa.com/api/v1/runs';

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** @param {string} secret */
async function deriveHmacKey(secret) {
  const ikm = await subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('certusqa-v1'), info: enc.encode('hmac') }, ikm, 256);
  return hex(bits);
}

async function hmacHex(hmacKeyHex, message) {
  const key = await subtle.importKey('raw', hexToBytes(hmacKeyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await subtle.sign('HMAC', key, enc.encode(message)));
}

/**
 * @param {string} body
 * @param {string} secret
 * @param {number} [ts]
 */
async function signRequest(body, secret, ts = Math.floor(Date.now() / 1000)) {
  const hmacKey = await deriveHmacKey(secret);
  const [plain, versioned] = await Promise.all([hmacHex(hmacKey, body), hmacHex(hmacKey, `${ts}.${body}`)]);
  return {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
    'X-CertusQA-Signature': `sha256=${plain}`,
    'X-CertusQA-Signature-Versioned': `t=${ts},v1=${versioned}`,
  };
}

/**
 * GitHub context → externalRef. Returns null (with a reason) when the context
 * cannot produce a valid reference, e.g. outside Actions.
 * @param {Record<string, string|undefined>} env
 */
function externalRefFrom(env) {
  const repo = String(env.GITHUB_REPOSITORY || '').trim();
  const sha = String(env.GITHUB_SHA || '').trim();
  if (!repo || !/^[0-9a-f]{7,40}$/i.test(sha)) return { ref: null, reason: 'GITHUB_REPOSITORY and GITHUB_SHA are required to identify the run' };
  const prMatch = /^refs\/pull\/(\d+)\//.exec(String(env.GITHUB_REF || ''));
  const ref = {
    provider: 'github',
    repo,
    sha,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : undefined,
    runAttempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : undefined,
    prNumber: prMatch ? Number(prMatch[1]) : undefined,
    ref: env.GITHUB_REF_NAME || undefined,
    workflow: env.GITHUB_WORKFLOW || undefined,
  };
  for (const k of Object.keys(ref)) if (ref[k] === undefined) delete ref[k];
  return { ref, reason: null };
}

/**
 * The platform payload, from what gate.js wrote.
 * @param {object} gate  gate.json contents
 * @param {object[]} artifacts  proof/*.json contents
 * @param {Record<string, string|undefined>} env
 */
function buildPayload(gate, artifacts, env) {
  const { ref, reason } = externalRefFrom(env);
  if (!ref) return { payload: null, reason };
  return {
    payload: {
      schemaVersion: '2.0.0',
      source: { tool: 'gate-action', version: ACTION_VERSION },
      externalRef: ref,
      gate: {
        verdict: gate.verdict,
        mode: gate.mode,
        generatedAt: gate.generatedAt,
        reportStatus: gate.reportStatus,
        summary: gate.summary,
      },
      artifacts,
    },
    reason: null,
  };
}

/**
 * Read what gate.js wrote.
 * @param {string} outputDir
 */
function readEvidence(outputDir) {
  const gate = JSON.parse(fs.readFileSync(path.join(outputDir, 'gate.json'), 'utf8'));
  const proofDir = path.join(outputDir, 'proof');
  const artifacts = fs.existsSync(proofDir)
    ? fs
        .readdirSync(proofDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(fs.readFileSync(path.join(proofDir, f), 'utf8')))
    : [];
  return { gate, artifacts };
}

/**
 * @param {{ outputDir: string, apiKey: string, apiUrl?: string, env?: Record<string, string|undefined>, fetchFn?: typeof fetch, nowSec?: number }} opts
 * @returns {Promise<{ ok: boolean, status?: number, runId?: string, url?: string, replayed?: boolean, warning?: string }>}
 */
async function upload(opts) {
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const apiUrl = opts.apiUrl || DEFAULT_URL;
  if (!fetchFn) return { ok: false, warning: 'fetch is not available in this Node runtime (need Node 18+)' };

  const { gate, artifacts } = readEvidence(opts.outputDir);
  const { payload, reason } = buildPayload(gate, artifacts, env);
  if (!payload) return { ok: false, warning: `not uploaded: ${reason}` };

  const body = JSON.stringify(payload);
  const headers = await signRequest(body, opts.apiKey, opts.nowSec);
  const idem = env.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}-${env.GITHUB_JOB || 'job'}` : undefined;
  if (idem) headers['Idempotency-Key'] = idem;

  let res;
  try {
    res = await fetchFn(apiUrl, { method: 'POST', headers, body });
  } catch (err) {
    return { ok: false, warning: `upload failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (res.status === 201 && data && data.run_id) {
    return { ok: true, status: 201, runId: data.run_id, url: data.url, replayed: res.headers.get('Idempotent-Replayed') === 'true', sanitisedServerSide: data.sanitised_server_side === true };
  }
  const detail = data && data.error ? `${data.error}${Array.isArray(data.detail) ? ` (${data.detail.slice(0, 3).join('; ')})` : ''}` : `HTTP ${res.status}`;
  return { ok: false, status: res.status, warning: `upload refused: ${detail}` };
}

module.exports = { ACTION_VERSION, DEFAULT_URL, deriveHmacKey, hmacHex, signRequest, externalRefFrom, buildPayload, readEvidence, upload };
