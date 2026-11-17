/*
controls.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The PAM vocabulary as Strudel controls. Each one only writes a key into the hap's value, and the
// `.pam()` output (and the offline freezer) read them through src/pam/events.mjs.
//
// Nothing here imports Strudel: `createControls` is handed the core that it registers with, which
// is the npm package under Node and the page's own copy on strudel.cc.

import { cellParamNames, isCellParamName, listParams, resolveParam } from '../pam/params.mjs';

const SWITCHES = new Set(['mute', 'solo']);

// Closest names to a mistyped one: same letters ignoring case first, then names that contain it.
function suggest(name) {
  const key = String(name).toLowerCase();
  const all = [...cellParamNames(), ...listParams({ cells: [] }).map((p) => p.id)];
  const exact = all.filter((n) => n.toLowerCase() === key);
  if (exact.length) return exact;
  return all.filter((n) => n.toLowerCase().includes(key) || key.includes(n.toLowerCase())).slice(0, 5);
}

/**
 * The hap key a knob id is stored under: a per-cell name becomes `cell_<name>`, waiting for the
 * hap's cell, and a full id stays as it is. Throws on a name that PAM does not have.
 */
export function knobKey(id) {
  const name = String(id);
  const open = /^cell_(.+)$/.exec(name);
  const bare = open ? open[1] : name;
  if (SWITCHES.has(bare) || isCellParamName(bare)) return `cell_${bare}`;
  if (/^cell\d+_(mute|solo)$/.test(name) || resolveParam(name)) return name;
  const near = suggest(bare);
  throw new Error(`[pam] knob: PAM has no parameter "${name}"${near.length ? `. Close: ${near.join(', ')}` : ''}`);
}

/**
 * Registers the controls with one copy of Strudel's core and returns them.
 * @param {{ Pattern: Function, registerControl: Function, reify: Function }} core
 */
export function createControls({ Pattern, registerControl, reify }) {
  /**
   * The cell a note, knob or press is for: 1-8, or a name from the setup. On its own it plays
   * nothing: a hap sounds when it has a pitch (`note`, `n`, `freq`) or a sound (`s`).
   *
   * @name cell
   * @memberof Pattern
   * @param {number | string | Pattern} cell
   * @example
   * note("c2 eb2 g2 bb2").cell(5).pam()
   * @example
   * knob("filterCutoff", sine.range(200, 8000).segment(16)).cell(5).pam()
   */
  const { cell } = registerControl('cell');

  /**
   * Switches PAM to one of its eight variations. PAM makes the switch on the next bar line, so a
   * variation patterned per cycle changes on the bar.
   *
   * @name variation
   * @memberof Pattern
   * @synonyms vari
   * @param {number | Pattern} slot 1-8
   * @example
   * variation("<1 1 2 3>/4").pam()
   */
  const { variation, vari } = registerControl('variation', 'vari');

  /**
   * Presses one of PAM's buttons at each onset: `mute`, `solo`, `stop` and `trigger` for the hap's
   * cell, `record` (MIDI record), and the looper's `looperRecord`, `looperArmAll`, `looperDisarmAll`,
   * `looperClearAll`, `looperCapture`, `looperArm:n`, `looperMute:n`, `looperSolo:n`, `looperClear:n`
   * and `looperVariation:n`, plus `resample` into the hap's cell. `mute` and `solo` toggle, as PAM's
   * own MIDI actions do, and `knob("mute", 1)` sets them.
   *
   * @name press
   * @memberof Pattern
   * @param {string | Pattern} action
   * @example
   * press("<mute ~ mute ~>").cell(3).pam()
   * @example
   * press("looperRecord").slow(8).pam()
   */
  const { press } = registerControl('press');

  /**
   * Turns one of PAM's knobs: any parameter that a MIDI mapping can reach, by PAM's own id, in its
   * own unit (Hz, dB, %, semitones; an enum by number or by name).
   *
   * A per-cell name (`filterCutoff`, `delayMix`, `synth_p1`, `mute`) goes to the hap's cell. A full id
   * (`cell3_delayMix`, `macro_filterCutoff`, `crossfade`, `lfo1_lfoRate`) needs none. `volume` is the
   * cell's fader on a cell and the master's without one.
   *
   * As a function it is a pattern of knob moves with the value's structure. As a method it sets the
   * knob on each note of the pattern, just before the note.
   *
   * @name knob
   * @memberof Pattern
   * @param {string | Pattern} id PAM parameter id, or a per-cell name
   * @param {number | string | Pattern} value
   * @example
   * knob("filterCutoff", "<300 1200 8000 2500>").cell(3).pam()
   * @example
   * note("c2*8").cell(5).knob("cmi_p2", sine.range(0.2, 0.9).slow(4)).pam()
   * @example
   * knob("macro_filterCutoff", saw.range(200, 12000).slow(8).segment(32)).pam()
   */
  function knob(id, value, pat) {
    const values = (key) => reify(value).fmap((v) => ({ [key]: v }));
    // In the REPL a double-quoted id arrives as a pattern. Its first cycle is checked here, so a
    // mistyped name fails when the code is evaluated rather than on every scheduler tick.
    if (typeof id !== 'string') for (const hap of reify(id).queryArc(0, 1)) knobKey(hap.value);
    const moves = typeof id === 'string' ? values(knobKey(id)) : reify(id).fmap((i) => values(knobKey(i))).innerJoin();
    return pat === undefined ? moves : pat.set(moves);
  }

  Pattern.prototype.knob = function (id, value) {
    return knob(id, value, this);
  };

  return { cell, variation, vari, press, knob };
}
