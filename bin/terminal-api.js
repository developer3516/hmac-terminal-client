#!/usr/bin/env node

/**
 * terminal-api — sign, inspect and send HMAC-signed requests from a shell.
 *
 * The `sign` and `canonical` subcommands are the reason this exists. When a
 * server rejects a signature there is nothing in the 401 to work with, and the
 * fastest way through is to print the exact string the client hashed and diff
 * it against the one the server built. Doing that from a REPL means writing a
 * throwaway script every time; doing it from a shell is one command.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { TerminalClient } from '../src/client.js';
import { ApiError, NetworkError, TerminalError, TimeoutError } from '../src/errors.js';
import { buildCanonicalRequest, signRequest, verifyRequest } from '../src/signature.js';

const EXIT = {
  ok: 0,
  apiError: 1,
  usage: 2,
  transport: 3,
  signatureInvalid: 4,
};

const USAGE = `
terminal-api — HMAC-signed API client

USAGE
  terminal-api <command> [options]

COMMANDS
  request <METHOD> <PATH>    sign and send a request
  sign <METHOD> <PATH>       print the signature headers without sending
  canonical <METHOD> <PATH>  print only the canonical request string
  verify <METHOD> <PATH>     check a signature against supplied headers

OPTIONS
  --base-url <url>      API origin              [env TERMINAL_BASE_URL]
  --key-id <id>         key identifier          [env TERMINAL_KEY_ID]
  --secret <secret>     shared secret           [env TERMINAL_SECRET]
  -q, --query <k=v>     query parameter, repeatable
  -H, --header <k=v>    request header, repeatable
  -d, --body <json>     request body; "-" reads stdin
  --body-file <path>    request body from a file
  --timestamp <unix>    pin the timestamp (reproducing a signature)
  --nonce <hex>         pin the nonce
  --timeout <ms>        per-request timeout
  --no-retry            disable retries
  --json                machine-readable output
  -h, --help            show this message

ENVIRONMENT
  Prefer TERMINAL_SECRET over --secret. Arguments are visible to any process
  that can read /proc or run ps, and they land in shell history; environment
  variables do neither.

EXAMPLES
  terminal-api sign GET /terminals -q status=active
  terminal-api canonical POST /terminals/T-1/capture -d '{"amount":1250}'
  terminal-api request GET /terminals --json
`.trimStart();

const OPTIONS = {
  'base-url': { type: 'string' },
  'key-id': { type: 'string' },
  secret: { type: 'string' },
  query: { type: 'string', short: 'q', multiple: true },
  header: { type: 'string', short: 'H', multiple: true },
  body: { type: 'string', short: 'd' },
  'body-file': { type: 'string' },
  timestamp: { type: 'string' },
  nonce: { type: 'string' },
  timeout: { type: 'string' },
  'no-retry': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

/** Split repeatable `k=v` flags into an object, preserving repeated keys. */
function parsePairs(values = [], label) {
  const out = {};

  for (const entry of values) {
    const at = entry.indexOf('=');
    if (at < 1) throw new UsageError(`${label} must be key=value, got "${entry}"`);

    const key = entry.slice(0, at);
    const value = entry.slice(at + 1);

    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }

  return out;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (cause) {
    throw new UsageError(`could not read body from stdin: ${cause.message}`);
  }
}

function resolveBody(values) {
  if (values['body-file'] !== undefined) {
    if (values.body !== undefined) throw new UsageError('use --body or --body-file, not both');
    try {
      return readFileSync(values['body-file'], 'utf8');
    } catch (cause) {
      throw new UsageError(`could not read ${values['body-file']}: ${cause.message}`);
    }
  }

  if (values.body === undefined) return undefined;
  return values.body === '-' ? readStdin() : values.body;
}

function requireCredentials(values, { needBaseUrl }) {
  const keyId = values['key-id'] ?? process.env.TERMINAL_KEY_ID;
  const secret = values.secret ?? process.env.TERMINAL_SECRET;
  const baseUrl = values['base-url'] ?? process.env.TERMINAL_BASE_URL;

  if (!keyId) throw new UsageError('missing key id — pass --key-id or set TERMINAL_KEY_ID');
  if (!secret) throw new UsageError('missing secret — pass --secret or set TERMINAL_SECRET');
  if (needBaseUrl && !baseUrl) {
    throw new UsageError('missing base url — pass --base-url or set TERMINAL_BASE_URL');
  }

  return { keyId, secret, baseUrl };
}

function parseIntOption(raw, name) {
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} must be an integer, got "${raw}"`);

  return value;
}

function requireTarget(positionals, command) {
  const [method, path] = positionals;

  if (!method || !path) throw new UsageError(`${command} needs a METHOD and a PATH`);
  if (!path.startsWith('/')) throw new UsageError(`PATH must start with "/", got "${path}"`);

  return { method: method.toUpperCase(), path };
}

/*//////////////////////////////////////////////////////////////
                            COMMANDS
//////////////////////////////////////////////////////////////*/

function commandSign(positionals, values, { canonicalOnly }) {
  const { method, path } = requireTarget(positionals, canonicalOnly ? 'canonical' : 'sign');
  const { keyId, secret } = requireCredentials(values, { needBaseUrl: false });

  const query = parsePairs(values.query, '--query');
  const body = resolveBody(values);

  const signed = signRequest({
    keyId,
    secret,
    method,
    path,
    query,
    body,
    timestamp: parseIntOption(values.timestamp, 'timestamp'),
    ...(values.nonce ? { nonce: values.nonce } : {}),
  });

  if (canonicalOnly) {
    // Raw, unquoted, no trailing newline beyond the one the shell expects —
    // so it can be piped straight into diff against the server's version.
    process.stdout.write(`${signed.canonicalRequest}\n`);
    return EXIT.ok;
  }

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          canonicalRequest: signed.canonicalRequest,
          signature: signed.signature,
          timestamp: signed.timestamp,
          nonce: signed.nonce,
          headers: signed.headers,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }

  process.stdout.write('canonical request:\n');
  process.stdout.write(`${signed.canonicalRequest.replace(/^/gm, '  ')}\n\n`);
  process.stdout.write('headers:\n');
  for (const [name, value] of Object.entries(signed.headers)) {
    process.stdout.write(`  ${name}: ${value}\n`);
  }

  return EXIT.ok;
}

function commandVerify(positionals, values) {
  const { method, path } = requireTarget(positionals, 'verify');
  const { secret } = requireCredentials(values, { needBaseUrl: false });

  const headers = parsePairs(values.header, '--header');
  const result = verifyRequest({
    secret,
    headers,
    method,
    path,
    query: parsePairs(values.query, '--query'),
    body: resolveBody(values),
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.valid) {
    process.stdout.write('signature valid\n');
  } else {
    process.stderr.write(`signature invalid: ${result.reason}\n`);
    // A canonical request to diff against is the whole point of failing here.
    process.stderr.write('\nthe canonical request this end built:\n');
    process.stderr.write(
      `${buildCanonicalRequest({
        method,
        path,
        query: parsePairs(values.query, '--query'),
        timestamp: Number(headers['x-timestamp'] ?? 0),
        nonce: headers['x-nonce'] ?? 'missing',
        body: resolveBody(values),
      }).replace(/^/gm, '  ')}\n`,
    );
  }

  return result.valid ? EXIT.ok : EXIT.signatureInvalid;
}

async function commandRequest(positionals, values) {
  const { method, path } = requireTarget(positionals, 'request');
  const { keyId, secret, baseUrl } = requireCredentials(values, { needBaseUrl: true });

  const client = new TerminalClient({
    baseUrl,
    keyId,
    secret,
    timeoutMs: parseIntOption(values.timeout, 'timeout'),
    defaultHeaders: parsePairs(values.header, '--header'),
    retry: values['no-retry'] ? false : undefined,
  });

  const response = await client.request(method, path, {
    query: parsePairs(values.query, '--query'),
    body: resolveBody(values),
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } else {
    process.stdout.write(`${response.status}\n`);
    process.stdout.write(
      `${typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2)}\n`,
    );
  }

  return EXIT.ok;
}

/*//////////////////////////////////////////////////////////////
                              ENTRY
//////////////////////////////////////////////////////////////*/

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? EXIT.ok : EXIT.usage;
  }

  if (values.secret) {
    // Not fatal — sometimes it is genuinely the only option — but worth
    // saying out loud, because argv is readable by other processes and ends
    // up in shell history.
    process.stderr.write('warning: --secret is visible in ps output and shell history; ');
    process.stderr.write('prefer TERMINAL_SECRET\n');
  }

  try {
    switch (command) {
      case 'sign':
        return commandSign(rest, values, { canonicalOnly: false });
      case 'canonical':
        return commandSign(rest, values, { canonicalOnly: true });
      case 'verify':
        return commandVerify(rest, values);
      case 'request':
        return await commandRequest(rest, values);
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    return reportError(error, values.json);
  }
}

function reportError(error, asJson) {
  if (error instanceof UsageError) {
    process.stderr.write(`error: ${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }

  if (error instanceof ApiError) {
    if (asJson) {
      process.stderr.write(
        `${JSON.stringify({ status: error.status, code: error.code, message: error.message, body: error.body }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`error: ${error.status} ${error.message}\n`);
      if (error.requestId) process.stderr.write(`request id: ${error.requestId}\n`);
    }
    return EXIT.apiError;
  }

  if (error instanceof NetworkError || error instanceof TimeoutError) {
    process.stderr.write(`error: ${error.message}\n`);
    return EXIT.transport;
  }

  if (error instanceof TerminalError) {
    process.stderr.write(`error: ${error.message}\n`);
    return EXIT.usage;
  }

  throw error;
}

// Only take over the process when run as a binary; importing for tests must
// not set an exit code. `pathToFileURL` rather than string-concatenating
// `file://` — on Windows the latter produces `file://D:\...`, which never
// matches `import.meta.url` and would leave the CLI silently doing nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
