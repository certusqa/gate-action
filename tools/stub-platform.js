#!/usr/bin/env node
'use strict';
/**
 * A stand-in for the CertusQA platform for the action's self-test in CI.
 * Verifies the bearer and BOTH signature headers with an independent
 * node:crypto derivation, then answers like the real ingestion endpoint.
 * Refuses anything else with the real error codes.
 *
 * Usage: node tools/stub-platform.js <port> <secret>
 */
const crypto = require('crypto');
const http = require('http');

const port = Number(process.argv[2] || 8099);
const secret = process.argv[3] || 'cqa_live_stub';
const hmacKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'certusqa-v1', 'hmac', 32));
const hmac = (m) => crypto.createHmac('sha256', hmacKey).update(m, 'utf8').digest('hex');

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const reply = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || !req.url.endsWith('/api/v1/runs')) return reply(404, { error: 'not_found' });
      if (req.headers.authorization !== `Bearer ${secret}`) return reply(401, { error: 'invalid_api_key' });
      const v = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.headers['x-certusqa-signature-versioned'] || ''));
      if (!v) return reply(401, { error: 'missing_signature' });
      if (Math.abs(Math.floor(Date.now() / 1000) - Number(v[1])) > 300) return reply(401, { error: 'signature_timestamp_out_of_window' });
      if (hmac(`${v[1]}.${body}`) !== v[2]) return reply(401, { error: 'bad_signature' });
      if (String(req.headers['x-certusqa-signature'] || '') !== `sha256=${hmac(body)}`) return reply(401, { error: 'bad_signature' });
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      if (p.schemaVersion !== '2.0.0' || !p.gate || !p.externalRef || !Array.isArray(p.artifacts)) return reply(422, { error: 'invalid_payload' });
      process.stderr.write(`stub-platform: accepted ${p.gate.verdict} from ${p.externalRef.repo}@${p.externalRef.sha.slice(0, 7)} with ${p.artifacts.length} artifact(s), idempotency ${req.headers['idempotency-key'] || '-'}\n`);
      reply(201, { run_id: 'run_stub0001', verdict: p.gate.verdict, artifacts: p.artifacts.length, sanitised_server_side: false, url: 'https://app.certusqa.com/app/runs/run_stub0001' });
    });
  })
  .listen(port, '127.0.0.1', () => process.stderr.write(`stub-platform: listening on ${port}\n`));
