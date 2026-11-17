/*
events.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// One pattern event's value map -> what it asks of PAM. The value map is flat and holds only
// strings and numbers, which is what Strudel haps and Tidal's OSC messages have in common, so this
// module is the whole of the language-neutral vocabulary:
//
//   s            a cell by name or number: plays it
//   note n freq  the pitch: plays the cell that `cell` (or `s`) names
//   cell         the cell a note, knob or press is for. Alone it plays nothing
//   velocity gain  how hard
//   cell_<name>  a knob of that cell (`cell_filterCutoff`), in the parameter's own unit
//   <full id>    any other knob (`macro_filterCutoff`, `cell3_delayMix`, `crossfade`)
//   cell_mute cell_solo  the cell's mute and solo, 0 or 1
//   variation    the variation to switch to, 1-8
//   press        an action: `mute`, `solo`, `stop`, `trigger`, `record`, `looperRecord`, ...
//   progNum midicmd ccn ccv nrpnn nrpv midichan  plain MIDI, as @strudel/midi reads them
//
// The MIDI encoder and the freezer both consume the events that this returns.

import { PAM_CELLS, PAM_VARIATIONS, clamp, isCell, isCellParamName, parseParamValue, resolveParam } from './params.mjs';
import { isChannel, isSevenBit, parseAction } from './midimap.mjs';

/**
 * @typedef {object} PamNote
 * @property {'note'} type
 * @property {number} cell
 * @property {number} [note] MIDI note asked for by `note` or `freq`; absent plays the cell's own note
 * @property {number} [n] steps above the cell's root (a slice, or a key), when `n` came without `note`
 * @property {number} velocity 0..1
 *
 * @typedef {object} PamKnob
 * @property {'knob'} type
 * @property {import('./params.mjs').PamParam} param
 * @property {number} value in the parameter's unit, clamped to its range
 *
 * @typedef {{ type: 'switch', what: 'mute' | 'solo', cell: number, on: boolean }} PamSwitch
 * @typedef {{ type: 'variation', index: number }} PamVariation
 * @typedef {{ type: 'press', name: string, cell?: number, arg?: number }} PamPress
 * @typedef {{ type: 'preset', index: number }} PamPreset
 * @typedef {{ type: 'transport', command: 'start' | 'stop' | 'continue' | 'clock' }} PamTransport
 * @typedef {{ type: 'cc', channel: number, cc: number, value: number }} PamCc value 0..127
 * @typedef {{ type: 'nrpn', channel: number, number: number, value: number }} PamNrpn value 0..127
 *
 * @typedef {PamNote | PamKnob | PamSwitch | PamVariation | PamPress | PamPreset | PamTransport | PamCc | PamNrpn} PamEvent
 */

// Keys a hap may carry that are not PAM's to interpret: left to whatever else the pattern feeds.
const RESERVED = new Set([
  's',
  'n',
  'note',
  'freq',
  'cell',
  'velocity',
  'gain',
  'variation',
  'press',
  'progNum',
  'midicmd',
  'ccn',
  'ccv',
  'nrpnn',
  'nrpv',
  'midichan',
]);

const NOTE_NAMES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** MIDI note number of `60`, `"60"`, `"c3"`, `"eb2"`, `"f#4"`, in Strudel's octave numbering (c3 = 48). */
export function noteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  const m = /^([a-g])([#bsf]*)(-?\d+)?$/.exec(text);
  if (!m) return undefined;
  let semis = NOTE_NAMES[m[1]];
  for (const acc of m[2]) semis += acc === '#' || acc === 's' ? 1 : -1;
  const octave = m[3] === undefined ? 3 : Number(m[3]);
  return (octave + 1) * 12 + semis;
}

/** The MIDI note of a frequency in Hz, fractional. */
export const freqToMidi = (freq) => 69 + 12 * Math.log2(freq / 440);
const asCell = (v) => (isCell(v) ? v : undefined);

/** How hard a note with no `velocity` is played, 0..1. */
export const DEFAULT_VELOCITY = 0.9;
/** The MIDI velocity, 1-127, of a note event's 0..1. */
export const midiVelocity = (velocity) => clamp(Math.round(velocity * 127), 1, 127);
/** How long a note of `length` is held: a `gap` short of it, so that a repeat retriggers, or half of a note that is too short for that. */
export const heldLength = (length, gap) => (length > gap * 2 ? length - gap : length / 2);

function cellOf(value, names) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return asCell(value);
  const key = String(value).trim();
  if (Object.hasOwn(names, key)) return names[key];
  return asCell(Number(key));
}

const truthy = (v) => !(v === 0 || v === false || v === '0' || v === 'false' || v === 'off' || v === '~');

/**
 * Reads one event's value map.
 *
 * @param {Record<string, unknown>} value the hap value (or a Tidal OSC message's pairs)
 * @param {{ names?: Record<string, number> }} [setup] sound names for `s` and `cell`
 * @returns {{ events: PamEvent[], problems: string[] }} `problems` name what was asked for and
 *   cannot be done. A problem never throws, so one bad voice cannot stop the others
 */
export function compileValue(value, setup = {}) {
  const events = [];
  const problems = [];
  if (value === null || typeof value !== 'object') return { events, problems };
  const names = setup.names ?? {};

  // Which cell: `cell` says so outright. Otherwise `s` does, when it names one.
  let cell;
  if (value.cell !== undefined) {
    cell = cellOf(value.cell, names);
    if (cell === undefined) problems.push(`cell ${JSON.stringify(value.cell)} is not a cell (1-${PAM_CELLS}) or a name`);
  }
  const sCell = value.s === undefined ? undefined : cellOf(value.s, names);
  if (value.s !== undefined && sCell === undefined && value.cell === undefined) {
    problems.push(`s "${value.s}" names no cell: name it in the setup's names, or use 1-${PAM_CELLS}`);
  }
  if (cell === undefined) cell = sCell;

  // Knobs go first, so that a note's own knobs arrive before it.
  for (const [key, raw] of Object.entries(value)) {
    if (RESERVED.has(key)) continue;
    const open = /^cell_(.+)$/.exec(key);
    const isSwitch = /^cell\d*_(mute|solo)$/.exec(key);
    if (isSwitch) {
      const target = open ? cell : Number(/^cell(\d+)_/.exec(key)[1]);
      if (asCell(target) === undefined) problems.push(`${key} needs a cell`);
      else events.push({ type: 'switch', what: isSwitch[1], cell: target, on: truthy(raw) });
      continue;
    }
    // `cell_<name>` takes the hap's cell. Any other key has to be a full id, so that a Strudel
    // control which shares a per-cell name (pan, stretch, mode) is never read as PAM's.
    const param = open ? resolveParam(key, cell) : resolveParam(key);
    if (!param) {
      // An unknown key is someone else's control unless it was plainly meant for PAM.
      if (open) {
        problems.push(
          isCellParamName(open[1]) ? `${key} needs a cell` : `${key}: PAM has no per-cell parameter "${open[1]}"`,
        );
      }
      continue;
    }
    const parsed = parseParamValue(param, raw);
    if (parsed === undefined) {
      problems.push(`${param.id}: ${JSON.stringify(raw)} is not a value`);
      continue;
    }
    if (param.selector && parsed < 1) continue; // Off cannot be sent, and means "leave it"
    if (parsed < param.min || parsed > param.max) {
      // The message leaves the value out, because a knob that sweeps out of range would otherwise be a new problem at every hap.
      problems.push(`${param.id}: outside ${param.min}..${param.max}${param.unit ? ' ' + param.unit : ''}, clamped`);
    }
    events.push({ type: 'knob', param, value: clamp(parsed, param.min, param.max) });
  }

  if (value.variation !== undefined) {
    const index = Number(value.variation);
    if (Number.isInteger(index) && index >= 1 && index <= PAM_VARIATIONS) events.push({ type: 'variation', index });
    else if (index !== 0) problems.push(`variation ${JSON.stringify(value.variation)} is not 1-${PAM_VARIATIONS}`);
  }

  if (value.press !== undefined && truthy(value.press)) {
    const action = parseAction(value.press);
    if (!action) problems.push(`press "${value.press}" is not an action`);
    else if (action.def.cell && cell === undefined) problems.push(`press "${action.name}" needs a cell`);
    else events.push({ type: 'press', name: action.name, ...(action.def.cell ? { cell } : {}), ...(action.arg ? { arg: action.arg } : {}) });
  }

  const channel = value.midichan === undefined ? 1 : Number(value.midichan);
  const okChannel = isChannel(channel);
  if (value.midichan !== undefined && !okChannel) problems.push(`midichan ${JSON.stringify(value.midichan)} is not 1-16`);

  if (value.progNum !== undefined) {
    const index = Number(value.progNum);
    if (isSevenBit(index)) events.push({ type: 'preset', index });
    else problems.push(`progNum ${JSON.stringify(value.progNum)} is not 0-127`);
  }

  if (value.midicmd !== undefined) {
    const command = value.midicmd === 'midiClock' ? 'clock' : value.midicmd;
    if (['start', 'stop', 'continue', 'clock'].includes(command)) events.push({ type: 'transport', command });
    else problems.push(`midicmd "${value.midicmd}" is not clock, start, stop or continue`);
  }

  // Plain controllers, for whatever was learned by hand in PAM. ccv and nrpv are 0..1, as in @strudel/midi.
  if (value.ccn !== undefined && value.ccv !== undefined && okChannel) {
    const cc = Number(value.ccn);
    const v = Number(value.ccv);
    if (isSevenBit(cc) && Number.isFinite(v)) {
      events.push({ type: 'cc', channel, cc, value: clamp(Math.round(v * 127), 0, 127) });
    } else problems.push(`ccn ${JSON.stringify(value.ccn)} / ccv ${JSON.stringify(value.ccv)} is not a controller`);
  }
  if (value.nrpnn !== undefined && value.nrpv !== undefined && okChannel) {
    const number = Array.isArray(value.nrpnn) ? value.nrpnn[0] * 128 + value.nrpnn[1] : Number(value.nrpnn);
    const v = Number(value.nrpv);
    if (Number.isInteger(number) && number >= 0 && number <= 16383 && Number.isFinite(v)) {
      events.push({ type: 'nrpn', channel, number, value: clamp(Math.round(v * 127), 0, 127) });
    } else problems.push(`nrpnn ${JSON.stringify(value.nrpnn)} / nrpv ${JSON.stringify(value.nrpv)} is not an NRPN`);
  }

  // A note sounds when the event names a sound or a pitch. `cell` alone only addresses.
  const pitched = value.note !== undefined || value.freq !== undefined || value.n !== undefined;
  if (sCell !== undefined || pitched) {
    if (cell === undefined) {
      if (pitched && value.s === undefined && value.cell === undefined) problems.push('a note needs a cell: add .cell(n) or s(name)');
    } else {
      const velocity = clamp(Number(value.velocity ?? DEFAULT_VELOCITY) * Number(value.gain ?? 1), 0, 1);
      const event = { type: 'note', cell, velocity: Number.isFinite(velocity) ? velocity : DEFAULT_VELOCITY };
      if (value.note !== undefined) {
        const note = noteNumber(value.note);
        if (note === undefined) problems.push(`note ${JSON.stringify(value.note)} is not a note`);
        else event.note = note;
      } else if (value.freq !== undefined && Number(value.freq) > 0) {
        event.note = freqToMidi(Number(value.freq));
      } else if (value.n !== undefined) {
        const n = Number(value.n);
        if (Number.isFinite(n)) event.n = Math.round(n);
        else problems.push(`n ${JSON.stringify(value.n)} is not a number`);
      }
      // Velocity 0 is a rest, as `.gain(0)` is everywhere in Strudel: MIDI's quietest note-on still sounds.
      if (event.velocity > 0) events.push(event);
    }
  }
  return { events, problems };
}

/**
 * The MIDI note that a note event sends for a setup's cell: the pitch asked for, else `n` steps above
 * the cell's root, else the cell's own note (its root when it is poly).
 */
export function resolveNote(event, cellSetup) {
  let note;
  if (event.note !== undefined) note = Math.round(event.note);
  else if (event.n !== undefined) note = cellSetup.root + event.n;
  else note = cellSetup.poly ? cellSetup.root : cellSetup.note;
  return clamp(note, 0, 127);
}
