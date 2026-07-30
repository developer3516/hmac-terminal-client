import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCanonicalRequest, verifyRequest } from '../src/index.js';

const CLI = fileURLToPath(new URL('../bin/terminal-api.js', import.meta.url));
const SECRET = 'shhh-this-is-the-shared-secret';
const KEY_ID = 'ak_live_0123456789';
const TIMESTAMP = 1_767_225_600;
const NONCE = 'ff00ff00ff00ff00ff00ff00ff00ff00';

/**
 * Invoke the CLI as a real subprocess.
 *
 * Spawning rather than importing `main()` is deliberate: the exit code, the
 * stdout/stderr split and the argument parsing are the contract a CLI has, and
 * none of them are exercised by calling the function directly.
 */
function cli(args, { env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, TERMINAL_SECRET: SECRET, TERMINAL_KEY_ID: KEY_ID, ...env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    // Always close stdin, even with nothing to send. Leaving the pipe open
    // makes any command that reads stdin hang forever instead of failing.
    child.stdin.end(input ?? '');
  });
}

describe('CLI — usage', () => {
  it('prints help and exits 0 for --help', async () => {
    const { code, stdout } = await cli(['--help']);

    assert.equal(code, 0);
    assert.match(stdout, /terminal-api — HMAC-signed API client/);
  });

  it('exits 2 with usage when no command is given', async () => {
    const { code, stdout } = await cli([]);

    assert.equal(code, 2);
    assert.match(stdout, /USAGE/);
  });

  it('exits 2 on an unknown command', async () => {
    const { code, stderr } = await cli(['frobnicate']);

    assert.equal(code, 2);
    assert.match(stderr, /unknown command "frobnicate"/);
  });

  it('exits 2 on an unknown flag', async () => {
    const { code, stderr } = await cli(['sign', 'GET', '/x', '--nope']);

    assert.equal(code, 2);
    assert.match(stderr, /nope/);
  });

  it('names the missing credential instead of failing generically', async () => {
    const { code, stderr } = await cli(['sign', 'GET', '/terminals'], {
      env: { TERMINAL_SECRET: '', TERMINAL_KEY_ID: '' },
    });

    assert.equal(code, 2);
    assert.match(stderr, /missing key id/);
  });

  it('requires a base url only for request, not for sign', async () => {
    assert.equal((await cli(['sign', 'GET', '/terminals'])).code, 0);

    const { code, stderr } = await cli(['request', 'GET', '/terminals'], {
      env: { TERMINAL_BASE_URL: '' },
    });
    assert.equal(code, 2);
    assert.match(stderr, /missing base url/);
  });

  it('rejects a path without a leading slash', async () => {
    const { code, stderr } = await cli(['sign', 'GET', 'terminals']);

    assert.equal(code, 2);
    assert.match(stderr, /must start with "\/"/);
  });

  it('rejects a malformed key=value pair', async () => {
    const { code, stderr } = await cli(['sign', 'GET', '/x', '-q', 'novalue']);

    assert.equal(code, 2);
    assert.match(stderr, /--query must be key=value/);
  });

  it('warns when the secret comes from argv', async () => {
    // argv is readable by other processes and lands in shell history.
    const { code, stderr } = await cli(['sign', 'GET', '/x', '--secret', SECRET]);

    assert.equal(code, 0);
    assert.match(stderr, /prefer TERMINAL_SECRET/);
  });
});

describe('CLI — canonical', () => {
  it('prints exactly the canonical request, ready to diff', async () => {
    const { code, stdout } = await cli([
      'canonical', 'POST', '/terminals/T-1/capture',
      '-q', 'dryRun=true',
      '-d', '{"amount":1250}',
      '--timestamp', String(TIMESTAMP),
      '--nonce', NONCE,
    ]);

    const expected = buildCanonicalRequest({
      method: 'POST',
      path: '/terminals/T-1/capture',
      query: { dryRun: 'true' },
      timestamp: TIMESTAMP,
      nonce: NONCE,
      body: '{"amount":1250}',
    });

    assert.equal(code, 0);
    assert.equal(stdout, `${expected}\n`);
  });

  it('is deterministic for a pinned timestamp and nonce', async () => {
    const args = ['canonical', 'GET', '/terminals', '--timestamp', String(TIMESTAMP), '--nonce', NONCE];

    assert.equal((await cli(args)).stdout, (await cli(args)).stdout);
  });

  it('reads the body from stdin when given "-"', async () => {
    const { code, stdout } = await cli(
      ['canonical', 'POST', '/notes', '-d', '-', '--timestamp', String(TIMESTAMP), '--nonce', NONCE],
      { input: '{"text":"from stdin"}' },
    );

    const expected = buildCanonicalRequest({
      method: 'POST',
      path: '/notes',
      timestamp: TIMESTAMP,
      nonce: NONCE,
      body: '{"text":"from stdin"}',
    });

    assert.equal(code, 0);
    assert.equal(stdout, `${expected}\n`);
  });

  it('uppercases the method', async () => {
    const lower = await cli(['canonical', 'get', '/x', '--timestamp', String(TIMESTAMP), '--nonce', NONCE]);
    const upper = await cli(['canonical', 'GET', '/x', '--timestamp', String(TIMESTAMP), '--nonce', NONCE]);

    assert.equal(lower.stdout, upper.stdout);
    assert.match(lower.stdout, /^v1\nGET\n/);
  });
});

describe('CLI — sign', () => {
  it('emits headers a verifier accepts', async () => {
    const { code, stdout } = await cli([
      'sign', 'GET', '/terminals', '-q', 'status=active', '--json',
    ]);

    assert.equal(code, 0);
    const { headers } = JSON.parse(stdout);

    const result = verifyRequest({
      secret: SECRET,
      headers,
      method: 'GET',
      path: '/terminals',
      query: { status: 'active' },
    });

    assert.equal(result.valid, true, result.reason ?? '');
  });

  it('never prints the secret', async () => {
    const { stdout, stderr } = await cli(['sign', 'GET', '/terminals', '--json']);

    assert.ok(!stdout.includes(SECRET));
    assert.ok(!stderr.includes(SECRET));
  });

  it('prints a human-readable form by default', async () => {
    const { code, stdout } = await cli(['sign', 'GET', '/terminals']);

    assert.equal(code, 0);
    assert.match(stdout, /canonical request:/);
    assert.match(stdout, /x-signature: [0-9a-f]{64}/);
  });

  it('rejects a non-integer timestamp', async () => {
    const { code, stderr } = await cli(['sign', 'GET', '/x', '--timestamp', 'yesterday']);

    assert.equal(code, 2);
    assert.match(stderr, /--timestamp must be an integer/);
  });
});

describe('CLI — verify', () => {
  it('accepts a signature produced by sign', async () => {
    const signed = JSON.parse((await cli(['sign', 'PUT', '/terminals/T-1', '--json'])).stdout);

    const { code, stdout } = await cli([
      'verify', 'PUT', '/terminals/T-1',
      ...Object.entries(signed.headers).flatMap(([k, v]) => ['-H', `${k}=${v}`]),
    ]);

    assert.equal(code, 0);
    assert.match(stdout, /signature valid/);
  });

  it('exits 4 and shows its own canonical request when the body was tampered with', async () => {
    const signed = JSON.parse(
      (await cli(['sign', 'POST', '/notes', '-d', '{"a":1}', '--json'])).stdout,
    );

    const { code, stderr } = await cli([
      'verify', 'POST', '/notes',
      '-d', '{"a":2}',
      ...Object.entries(signed.headers).flatMap(([k, v]) => ['-H', `${k}=${v}`]),
    ]);

    assert.equal(code, 4);
    assert.match(stderr, /signature invalid: signature mismatch/);
    // The whole point of failing here is having something to diff.
    assert.match(stderr, /the canonical request this end built:/);
  });
});

describe('CLI — request', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        const body = Buffer.concat(chunks);

        // A real server-side verification, using the same module the client
        // signs with — this is the end-to-end proof that both halves agree.
        const result = verifyRequest({
          secret: SECRET,
          headers: req.headers,
          method: req.method,
          path: url.pathname,
          query: url.searchParams,
          body: body.length ? body : undefined,
        });

        res.setHeader('content-type', 'application/json');

        if (!result.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: result.reason }));
          return;
        }

        if (url.pathname === '/boom') {
          res.statusCode = 500;
          res.setHeader('x-request-id', 'req_boom');
          res.end(JSON.stringify({ code: 'internal', message: 'it broke' }));
          return;
        }

        res.statusCode = 200;
        res.end(JSON.stringify({ path: url.pathname, method: req.method }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('signs a request the server independently verifies', async () => {
    const { code, stdout } = await cli(['request', 'GET', '/terminals', '--json'], {
      env: { TERMINAL_BASE_URL: baseUrl },
    });

    assert.equal(code, 0);
    const response = JSON.parse(stdout);
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { path: '/terminals', method: 'GET' });
  });

  it('round-trips a query string through signing and verification', async () => {
    const { code, stdout } = await cli(
      ['request', 'GET', '/terminals', '-q', 'status=active', '-q', 'limit=10', '--json'],
      { env: { TERMINAL_BASE_URL: baseUrl } },
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).status, 200);
  });

  it('round-trips a POST body', async () => {
    const { code, stdout } = await cli(
      ['request', 'POST', '/terminals', '-d', '{"label":"front desk"}', '--json'],
      { env: { TERMINAL_BASE_URL: baseUrl } },
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).data.method, 'POST');
  });

  it('exits 1 on an API error and surfaces the request id', async () => {
    const { code, stderr } = await cli(['request', 'GET', '/boom', '--no-retry'], {
      env: { TERMINAL_BASE_URL: baseUrl },
    });

    assert.equal(code, 1);
    assert.match(stderr, /error: 500 it broke/);
    assert.match(stderr, /request id: req_boom/);
  });

  it('exits 1 with a 401 when the secret does not match the server', async () => {
    const { code, stderr } = await cli(['request', 'GET', '/terminals', '--no-retry'], {
      env: { TERMINAL_BASE_URL: baseUrl, TERMINAL_SECRET: 'wrong-secret' },
    });

    assert.equal(code, 1);
    assert.match(stderr, /401/);
  });

  it('exits 3 when the host is unreachable', async () => {
    const { code, stderr } = await cli(['request', 'GET', '/terminals', '--no-retry'], {
      env: { TERMINAL_BASE_URL: 'http://127.0.0.1:1' },
    });

    assert.equal(code, 3);
    assert.match(stderr, /failed/);
  });
});
