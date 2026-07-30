import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import * as runtime from '../src/index.js';

/**
 * Keep `index.d.ts` honest without installing TypeScript.
 *
 * Adding `typescript` purely to run `tsc --noEmit` over a fixture would put
 * the first entry in a `devDependencies` block that is empty on purpose. The
 * failure mode those declarations actually have is drift — a new export ships
 * and nobody updates the types, or a rename leaves a declaration pointing at
 * something that no longer exists — and both of those are catchable by
 * comparing the two lists.
 *
 * This does not verify that the *shapes* are right. Nothing here would catch a
 * parameter typed `string` that should be `number`. It catches the whole
 * category of missing and stale declarations, which is the one that actually
 * bites.
 */

const declarations = readFileSync(new URL('../src/index.d.ts', import.meta.url), 'utf8');

/** Names declared as runtime values — these must exist in the module. */
function declaredValues(source) {
  const names = new Set();
  const pattern = /^export declare (?:abstract )?(?:class|function|const) (\w+)/gm;

  for (const match of source.matchAll(pattern)) names.add(match[1]);

  return names;
}

/** Names declared as types only — these must *not* exist at runtime. */
function declaredTypes(source) {
  const names = new Set();
  const pattern = /^export (?:interface|type) (\w+)/gm;

  for (const match of source.matchAll(pattern)) names.add(match[1]);

  return names;
}

describe('index.d.ts', () => {
  const values = declaredValues(declarations);
  const types = declaredTypes(declarations);
  const exported = new Set(Object.keys(runtime));

  it('parses out a plausible number of declarations', () => {
    // A guard on the guard: if the regexes stop matching, every assertion
    // below passes vacuously and the file silently stops being checked.
    assert.ok(values.size > 20, `only found ${values.size} value declarations`);
    assert.ok(types.size > 5, `only found ${types.size} type declarations`);
  });

  it('declares every runtime export', () => {
    const missing = [...exported].filter((name) => !values.has(name)).sort();

    assert.deepEqual(missing, [], `undeclared exports: ${missing.join(', ')}`);
  });

  it('declares nothing that does not exist at runtime', () => {
    const stale = [...values].filter((name) => !exported.has(name)).sort();

    assert.deepEqual(stale, [], `stale declarations: ${stale.join(', ')}`);
  });

  it('does not declare a type and a value under the same name', () => {
    const collisions = [...types].filter((name) => values.has(name) || exported.has(name)).sort();

    assert.deepEqual(collisions, []);
  });

  it('documents the error hierarchy the runtime actually has', () => {
    // The declared `extends` chain is the part consumers narrow on, so a
    // mismatch here is worse than a missing declaration.
    const expected = {
      ConfigError: 'TerminalError',
      SignatureError: 'TerminalError',
      NetworkError: 'TerminalError',
      TimeoutError: 'TerminalError',
      ApiError: 'TerminalError',
      AuthError: 'ApiError',
      RateLimitError: 'ApiError',
      BulkError: 'TerminalError',
    };

    for (const [child, parent] of Object.entries(expected)) {
      assert.match(
        declarations,
        new RegExp(`^export declare class ${child} extends ${parent}\\b`, 'm'),
        `${child} should be declared as extending ${parent}`,
      );
      assert.ok(
        Object.create(runtime[child].prototype) instanceof runtime[parent],
        `${child} does not actually extend ${parent} at runtime`,
      );
    }
  });
});

describe('package manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('points TypeScript at the declarations', () => {
    assert.equal(pkg.types, './src/index.d.ts');
  });

  it('ships them — `files` covers src', () => {
    assert.ok(pkg.files.includes('src'));
  });

  it('still has an empty dependency tree', () => {
    // The whole reason these declarations are hand-written.
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      assert.deepEqual(Object.keys(pkg[field] ?? {}), [], `${field} should be empty`);
    }
  });
});
