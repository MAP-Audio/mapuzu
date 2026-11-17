/*
page.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `mapuzu.mjs`, the entry for a page that already runs Strudel. This file never imports
// `index.mjs`, so the only Strudel in it is the one put in global scope here, as a REPL does at
// start.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '@strudel/core';
import { createBinding } from '../../src/strudel/binding.mjs';
import { serve } from '../../src/node/serve.mjs';
import { buildBrowserBundle } from '../../scripts/build-browser.mjs';

const VOCABULARY = ['cell', 'variation', 'vari', 'press', 'knob', 'pam', 'pamsetup', 'pamstatus', 'pamhush', 'pamclock', 'pamtheme'];

test('mapuzu.mjs binds to the Strudel the page has in scope and puts the vocabulary beside it', async () => {
  await core.evalScope(core);
  assert.equal(globalThis.Pattern.prototype.pam, undefined);
  assert.equal(globalThis.pamsetup, undefined);

  const page = await import('../../mapuzu.mjs');
  for (const name of VOCABULARY) assert.equal(typeof globalThis[name], 'function', name);
  assert.equal(globalThis.reset, undefined, 'the test seam stays out of the page');
  assert.equal(page.pamsetup, globalThis.pamsetup);

  // A pattern made by the page's own `s` plays through the output.
  const sent = [];
  await globalThis.pamsetup({ output: { send: (bytes) => sent.push([...bytes]) } });
  const hap = globalThis.s('3').knob('filterCutoff', 1200).pam().queryArc(0, 1)[0];
  await hap.context.onTrigger(hap, 0, 1, 0);
  assert.equal(sent.length, 5, 'three controllers for the knob, a note-on and a note-off');
  assert.deepEqual(sent[3], [0x90, 50, 114]);
});

test('a page with no Strudel in scope is told what is missing', () => {
  assert.throws(() => createBinding({ Pattern: class {}, logger() {} }), /no Strudel here to bind to: registerControl, reify, isPattern, midicmd are missing/);
  assert.throws(() => createBinding(undefined), /Pattern, registerControl, reify, isPattern, logger, midicmd are missing/);
});

// `import x from`, `export { x } from`, `export * from`, the last line of a longer list, and a bare `import`.
const IMPORT = /^\s*(?:import\s+[^'"\n]*?\s+from|export\s+(?:\*|\{[^}\n]*\})\s+from|\}\s*from|import)\s*['"]([^'"]+)['"]/gm;

// Every module `mapuzu.mjs` reaches, by reading the import statements.
function importGraph(entry) {
  const seen = new Map();
  const visit = (url) => {
    if (seen.has(url.href)) return;
    const specifiers = [...readFileSync(fileURLToPath(url), 'utf8').matchAll(IMPORT)].map((m) => m[1]);
    seen.set(url.href, specifiers);
    for (const specifier of specifiers) if (specifier.startsWith('.')) visit(new URL(specifier, url));
  };
  visit(entry);
  return seen;
}

test('everything mapuzu.mjs loads is imported by path, and `mapuzu serve` serves all of it and nothing else', async () => {
  const root = new URL('../../', import.meta.url);
  const graph = importGraph(new URL('mapuzu.mjs', root));
  assert.ok(graph.size >= 8, 'the entry, the binding, the controls, the output and the engine side');
  for (const [file, specifiers] of graph) {
    for (const specifier of specifiers) assert.match(specifier, /^\.\.?\//, `${file} imports ${specifier}: a page cannot resolve a package name`);
  }

  const server = await serve({ port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}/`;
    for (const file of graph.keys()) {
      const response = await fetch(base + file.slice(root.href.length));
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.match(response.headers.get('content-type'), /^text\/javascript/);
    }
    assert.equal((await fetch(`${base}songs/trap/cold-rail.strudel.js`)).status, 200);
    for (const path of ['package.json', 'index.mjs', 'src/node/serve.mjs', 'src/tidal/boot.mjs', 'songs/trap/cold-rail.preset', 'src/pam/%2e%2e/%2e%2e/package.json']) {
      assert.equal((await fetch(base + path)).status, 404, path);
    }
    assert.equal((await fetch(`${base}mapuzu.mjs`, { method: 'POST' })).status, 405);
    const preflight = await fetch(`${base}mapuzu.mjs`, { method: 'OPTIONS' });
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true', 'a public page asks before reaching this machine');
  } finally {
    await server.close();
  }
});

// dist/mapuzu.mjs, the one file a website serves. Runs last: importing it binds the page's Strudel again.
test('the browser bundle is one file with no Strudel in it, and it exports what mapuzu.mjs exports', async () => {
  const { text, inputs, imports } = await buildBrowserBundle({ write: false });
  assert.deepEqual(imports, [], 'the bundle imports nothing');
  assert.deepEqual([...text.matchAll(IMPORT)].map((m) => m[1]), [], 'no import statement is left, by path or by package name');
  assert.ok(inputs.includes('mapuzu.mjs') && inputs.length >= 8, 'the entry and what it reaches');
  for (const input of inputs) assert.match(input, /^(mapuzu\.mjs|src\/(strudel|pam)\/[\w.-]+\.mjs)$/, `${input} is in the bundle`);
  assert.ok(!inputs.includes('src/strudel/npm.mjs'), 'the module that imports @strudel/core stays out');
  assert.doesNotMatch(text, /@strudel\/|@kabelsalat\/|node_modules/);
  assert.match(text, /^\/\*\nmapuzu\.mjs - part of @mapaudio\/mapuzu \d+\.\d+\.\d+[^\n]*\n[^\n]*Source: https:\/\/[^\n]+\nThis program is free software/, 'it opens with its name, its source and the licence notice');

  const dir = mkdtempSync(join(tmpdir(), 'mapuzu-test-'));
  try {
    const file = join(dir, 'mapuzu.mjs');
    writeFileSync(file, text);
    const page = await import('../../mapuzu.mjs');
    const bundled = await import(/* @vite-ignore */ pathToFileURL(file).href);
    assert.deepEqual(Object.keys(bundled).sort(), Object.keys(page).sort());
    for (const name of VOCABULARY) assert.equal(globalThis[name], bundled[name], `${name} is the bundle's after it loads`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
