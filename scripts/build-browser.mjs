/*
build-browser.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Bundles mapuzu.mjs and everything it imports into one file, dist/mapuzu.mjs, which a website can
// serve as it is. `npm pack` and `npm publish` run this first (prepack), so a published package
// always carries the bundle of its own sources.
//
//   node scripts/build-browser.mjs
//
// The bundle holds no Strudel: mapuzu.mjs binds to the copy that the page already runs.

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = 'mapuzu.mjs';
export const BROWSER_BUNDLE = 'dist/mapuzu.mjs';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const source = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
// A bundler drops each module's header, so the bundle gets one of its own, with the same notice.
const notice = readFileSync(join(ROOT, ENTRY), 'utf8').split('\n').find((line) => line.startsWith('This program is free software'));
const banner = `/*
mapuzu.mjs - part of ${pkg.name} ${pkg.version}
One file, bundled from mapuzu.mjs, src/strudel/ and src/pam/. Source: ${source}
${notice}
*/`;

/**
 * Builds the bundle.
 * @param {object} [options]
 * @param {boolean} [options.write] default true. `false` leaves dist/ alone and only returns the result
 * @returns {Promise<{ text: string, inputs: string[], imports: string[] }>} the bundle's text, the
 *   source files in it, and what it still imports (nothing, or the build is wrong)
 */
export async function buildBrowserBundle({ write = true } = {}) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [ENTRY],
    outfile: BROWSER_BUNDLE,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    charset: 'utf8',
    legalComments: 'none',
    banner: { js: banner },
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const text = result.outputFiles[0].text;
  const output = result.metafile.outputs[BROWSER_BUNDLE];
  if (write) {
    mkdirSync(dirname(join(ROOT, BROWSER_BUNDLE)), { recursive: true });
    writeFileSync(join(ROOT, BROWSER_BUNDLE), text);
  }
  return { text, inputs: Object.keys(output.inputs), imports: output.imports.map((i) => i.path) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { text, inputs, imports } = await buildBrowserBundle();
  if (imports.length) throw new Error(`${BROWSER_BUNDLE} still imports ${imports.join(', ')}`);
  process.stdout.write(`${BROWSER_BUNDLE}: ${inputs.length} modules, ${(Buffer.byteLength(text) / 1024).toFixed(1)} kB\n`);
}
