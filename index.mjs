/*
index.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The Strudel package: what `evalScope(import('@mapaudio/mapuzu'))` puts in pattern scope. Every
// name here becomes a global in the REPL, so only the live-coding vocabulary is exported. The rest
// is behind subpaths: `@mapaudio/mapuzu/pam` (the engine side, no Strudel),
// `@mapaudio/mapuzu/node` (freeze and render) and `@mapaudio/mapuzu/tidal` (the TidalCycles side).
//
// A page that already runs Strudel (strudel.cc) loads `mapuzu.mjs` instead: this file imports
// `@strudel/core` by package name, which a bundler or Node can resolve and a page cannot.

import { binding } from './src/strudel/npm.mjs';

export const { cell, variation, vari, press, knob, pam, pamsetup, pamstatus, pamhush, pamclock, pamtheme, pamTrigger, pamDefaults } = binding;

export const packageName = '@mapaudio/mapuzu';
