/*
binding.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The Strudel vocabulary, bound to one copy of Strudel's core. Two copies of core in a page are two
// `Pattern` classes, and a method added to one is missing from patterns made by the other, so the
// core is an argument: `index.mjs` passes the npm package, and `mapuzu.mjs` passes the copy that a
// running REPL has already put in scope.

import { createControls } from './controls.mjs';
import { createOutput } from './output.mjs';
import { createTheme } from './theme.mjs';

const NEEDED = ['Pattern', 'registerControl', 'reify', 'isPattern', 'logger', 'midicmd'];

/**
 * @param {object} core `@strudel/core`'s exports, from wherever this page keeps them
 * @returns the controls (`cell`, `variation`, `vari`, `press`, `knob`), the output (`pam`,
 *   `pamsetup`, `pamstatus`, `pamhush`, `pamclock`, `pamTrigger`, `pamDefaults`), `pamtheme` and `reset` for tests
 */
export function createBinding(core) {
  const missing = NEEDED.filter((name) => typeof core?.[name] !== 'function');
  if (missing.length) throw new Error(`[pam] no Strudel here to bind to: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing`);
  return { ...createControls(core), ...createOutput(core), ...createTheme(core) };
}
