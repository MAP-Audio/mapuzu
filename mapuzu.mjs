/*
mapuzu.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The entry for a page that already runs Strudel, strudel.cc above all:
//
//   await import('http://localhost:4747/mapuzu.mjs')
//   await pamsetup({ channels: 'cell' })
//   $: s("1*4").pam()
//
// It imports nothing by package name, so it loads from any URL as it is, and it binds to the
// Strudel that the REPL has put in global scope. The quotes are single because the REPL reads a
// double-quoted string as mini-notation.
//
// The site it is imported from is also the site whose PAM `pamsetup({ web: true })` plays, in a
// browser tab and with no MIDI.

import { createBinding } from './src/strudel/binding.mjs';

const { reset: _reset, ...vocabulary } = createBinding(globalThis, { home: import.meta.url });
Object.assign(globalThis, vocabulary);

export const { cell, variation, vari, press, knob, pam, pamsetup, pamstatus, pamhush, pamclock, pamtheme, pamTrigger, pamDefaults } = vocabulary;
