/*
midimap.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// How MIDI reaches PAM, as data. Two halves:
//
// 1. What PAM listens to with no setup: each cell's note and channel, CC16 for variations, CC17-19
//    for the looper and resample, program change for presets. `createSetup` describes these, with
//    PAM's defaults, so a setup that changes nothing matches a PAM that changed nothing.
// 2. mapuzu's parameter map: one NRPN number for every mappable parameter and action. PAM learns it
//    from a mapping file (`mappingRows`, imported in Settings > Mappings), since PAM has no
//    default parameter map of its own.

import { PAM_CELLS, PAM_HOSTED_PER_CELL, isCell, listParams, resolveParam } from './params.mjs';

/** PAM's defaults: cell N answers note 47 + N on channel 1 and is not poly. A poly cell's root is 48. */
export const PAM_DEFAULT_NOTE = 48;
export const PAM_DEFAULT_ROOT = 48;

/** The fixed listeners in PAM's Settings > Mappings, at their defaults. Channel 0 is any channel. */
export const PAM_LISTENERS = Object.freeze({
  variation: Object.freeze({ channel: 1, cc: 16 }),
  looper: Object.freeze({ channel: 0, cc: 17 }),
  looperVariation: Object.freeze({ channel: 0, cc: 18 }),
  resample: Object.freeze({ channel: 0, cc: 19 }),
  preset: Object.freeze({ channel: 1 }),
});

/** PAM's "Auto Map": CC 1-8 on channel 1 to the eight CTRL-ALL macros. */
export const PAM_AUTOMAP = Object.freeze({
  macro_samplerVolume: 1,
  macro_pan: 2,
  macro_startPos: 3,
  macro_endPos: 4,
  macro_pitchShift: 5,
  macro_filterCutoff: 6,
  macro_filterQ: 7,
  macro_stretch: 8,
});

// mapuzu's parameter map: NRPN numbers, 14 bits.
const CELL_BLOCK = 1024; // globals 0..1023, cell c at c * 1024
const HOSTED_BASE = (PAM_CELLS + 1) * CELL_BLOCK; // 9216
const ACTION_BASE = HOSTED_BASE + PAM_CELLS * PAM_HOSTED_PER_CELL; // 12288
const GLOBAL_ACTION_BASE = ACTION_BASE + 64;

/**
 * What a `press` can fire. `cell` actions take the hap's cell; `listener` ones use a fixed listener
 * and need no mapping file; `track` ones take a looper track after a colon (`looperMute:3`).
 */
export const PAM_ACTIONS = Object.freeze({
  trigger: { cell: true, action: '__action_cellTrigger', n: 0 },
  stop: { cell: true, action: '__action_cellStop', n: 1 },
  mute: { cell: true, action: '__action_cellToggleMute', n: 2 },
  solo: { cell: true, action: '__action_cellToggleSolo', n: 3 },
  resample: { cell: true, listener: 'resample' },
  record: { action: '__action_midiRecordToggle', n: 0 },
  looperRecord: { listener: 'looper', code: 0 },
  looperArmAll: { listener: 'looper', code: 1 },
  looperDisarmAll: { listener: 'looper', code: 2 },
  looperClearAll: { listener: 'looper', code: 3 },
  looperCapture: { listener: 'looper', code: 4 },
  looperArm: { listener: 'looper', code: 10, track: true },
  looperMute: { listener: 'looper', code: 20, track: true },
  looperSolo: { listener: 'looper', code: 30, track: true },
  looperClear: { listener: 'looper', code: 40, track: true },
  looperVariation: { listener: 'looperVariation', track: true },
});

export const isChannel = (c) => Number.isInteger(c) && c >= 1 && c <= 16;
/** A note, controller or program number: 0-127. */
export const isSevenBit = (n) => Number.isInteger(n) && n >= 0 && n <= 127;

function perCell(option, fallback, what, valid) {
  const at = (i) => {
    if (option === undefined) return fallback(i);
    if (Array.isArray(option)) return option[i] ?? fallback(i);
    if (typeof option === 'object') return option[i + 1] ?? fallback(i);
    return option;
  };
  return Array.from({ length: PAM_CELLS }, (_, i) => {
    const v = at(i);
    if (!valid(v)) throw new Error(`[pam] setup: ${what} for cell ${i + 1} is ${JSON.stringify(v)}`);
    return v;
  });
}

/**
 * @typedef {object} PamSetup
 * @property {{ channel: number, note: number, root: number, poly: boolean }[]} cells index 0 is cell 1
 * @property {Record<string, number>} names sound name to cell
 * @property {number} control the channel mapuzu's parameter map (NRPN) is sent on
 * @property {typeof PAM_LISTENERS} listeners
 * @property {Record<string, { cc: number, channel: number }>} cc parameters that have a plain CC of their own
 */

/**
 * Describes one PAM's MIDI wiring. With no options it is PAM as installed: every cell on channel 1,
 * notes 48-55, no poly cells.
 *
 * @param {object} [options]
 * @param {'cell' | number | number[] | Record<number, number>} [options.channels] each cell's MIDI
 *   channel: one number for all, a list, or `'cell'` for cell N on channel N (what a preset needs
 *   to play more than one cell by pitch)
 * @param {number[] | Record<number, number>} [options.notes] each cell's trigger note (default 48-55)
 * @param {number | number[] | Record<number, number>} [options.roots] each poly cell's root note (default 48)
 * @param {number[] | boolean[]} [options.poly] the poly cells, as cell numbers or as one flag per cell
 * @param {Record<string, number>} [options.names] sound names for `s`, e.g. `{ bd: 1, sd: 2 }`
 * @param {number} [options.control] channel for mapuzu's parameter map (default 16)
 * @param {Partial<typeof PAM_LISTENERS>} [options.listeners] the fixed listeners, where PAM's were changed
 * @param {'automap' | Record<string, number | { cc: number, channel?: number }>} [options.cc]
 *   parameters to send as a plain CC instead of through mapuzu's map: ones learned by hand in PAM
 * @returns {PamSetup}
 */
export function createSetup(options = {}) {
  const channels = options.channels === 'cell' ? Array.from({ length: PAM_CELLS }, (_, i) => i + 1) : options.channels;
  const channel = perCell(channels, () => 1, 'channel', isChannel);
  const note = perCell(options.notes, (i) => PAM_DEFAULT_NOTE + i, 'note', isSevenBit);
  const root = perCell(options.roots, () => PAM_DEFAULT_ROOT, 'root', isSevenBit);
  let poly = options.poly ?? [];
  if (!Array.isArray(poly)) throw new Error('[pam] setup: poly is a list of cells or one flag per cell');
  if (!poly.every((p) => typeof p === 'boolean')) {
    const set = new Set(poly);
    for (const c of set) if (!isCell(c)) throw new Error(`[pam] setup: poly names cell ${JSON.stringify(c)}`);
    poly = Array.from({ length: PAM_CELLS }, (_, i) => set.has(i + 1));
  }
  const cells = channel.map((ch, i) => ({ channel: ch, note: note[i], root: root[i], poly: Boolean(poly[i]) }));

  const names = {};
  for (let c = 1; c <= PAM_CELLS; c++) {
    names[String(c)] = c;
    names[`c${c}`] = c;
  }
  for (const [name, cell] of Object.entries(options.names ?? {})) {
    if (!isCell(cell)) throw new Error(`[pam] setup: name "${name}" points at cell ${JSON.stringify(cell)}`);
    names[name] = cell;
  }

  const control = options.control ?? 16;
  if (!isChannel(control)) throw new Error(`[pam] setup: control channel is ${JSON.stringify(control)}`);

  const listeners = {};
  for (const [key, def] of Object.entries(PAM_LISTENERS)) listeners[key] = { ...def, ...options.listeners?.[key] };

  const cc = {};
  const given = options.cc === 'automap' ? PAM_AUTOMAP : (options.cc ?? {});
  for (const [id, target] of Object.entries(given)) {
    if (!resolveParam(id)) throw new Error(`[pam] setup: cc names "${id}", which is not a full PAM parameter id`);
    const entry = typeof target === 'number' ? { cc: target, channel: 1 } : { channel: 1, ...target };
    if (!isSevenBit(entry.cc) || !isChannel(entry.channel)) {
      throw new Error(`[pam] setup: cc for "${id}" is ${JSON.stringify(target)}`);
    }
    cc[id] = entry;
  }
  return { cells, names, control, listeners, cc };
}

/**
 * A setup read from a preset's state: each cell's channel, note, root and poly flag as the preset
 * saved them. `options` are `createSetup`'s, applied over what the preset says.
 *
 * @param {{ cells?: Record<string, object> }} state a preset's state block
 * @param {object} [options]
 */
export function setupFromState(state, options = {}) {
  const read = (key, fallback) =>
    Array.from({ length: PAM_CELLS }, (_, i) => {
      const v = state?.cells?.[String(i + 1)]?.[key];
      return typeof v === 'number' ? v : fallback(i);
    });
  const keymap = read('sliceKeymapMode', () => 0);
  return createSetup({
    channels: read('midiChannel', () => 1),
    notes: read('midiNote', (i) => PAM_DEFAULT_NOTE + i),
    roots: read('polyRootNote', () => PAM_DEFAULT_ROOT),
    // A slice-keymap cell takes notes from its root up, as a poly cell does.
    poly: read('isPoly', () => 0).map((p, i) => p > 0 || keymap[i] > 0),
    ...options,
  });
}

/** The NRPN number mapuzu's map gives a parameter. */
export function paramNumber(param) {
  if (param.scope === 'global') return param.n;
  if (param.scope === 'cell') return param.cell * CELL_BLOCK + param.n;
  return HOSTED_BASE + (param.cell - 1) * PAM_HOSTED_PER_CELL + param.n;
}

/**
 * Splits `press` values: `"mute"`, `"looperMute:3"`, or the `["looperMute", 3]` that mini-notation makes.
 * @returns {{ name: string, def: object, arg?: number } | undefined}
 */
export function parseAction(value) {
  const [name, arg] = Array.isArray(value) ? value : String(value).split(':');
  if (!Object.hasOwn(PAM_ACTIONS, name)) return undefined;
  const def = PAM_ACTIONS[name];
  if (!def.track) return arg === undefined ? { name, def } : undefined;
  const track = Number(arg);
  return Number.isInteger(track) && track >= 1 && track <= 8 ? { name, def, arg: track } : undefined;
}

/**
 * The mapping target and NRPN number of an action that goes through mapuzu's map, or `undefined`
 * for one that a fixed listener handles.
 */
export function actionTarget(name, cell) {
  const def = PAM_ACTIONS[name];
  if (!def?.action) return undefined;
  if (!def.cell) return { paramId: def.action, number: GLOBAL_ACTION_BASE + def.n };
  if (!isCell(cell)) return undefined;
  return { paramId: `${def.action}${cell}`, number: ACTION_BASE + def.n * PAM_CELLS + (cell - 1) };
}

/**
 * One row of a PAM mapping file, as Settings > Mappings > Export writes them.
 * @typedef {object} PamMappingRow
 * @property {string} id
 * @property {string} paramId
 * @property {'nrpn'} source
 * @property {number} channel 0 is any channel
 * @property {number} number
 * @property {'absolute'} mode
 * @property {{ min: number, max: number }} range the MIDI input window
 * @property {boolean} invert
 * @property {boolean} enabled
 */

const row = (paramId, number, channel) => ({
  id: `mapuzu-${number}`,
  paramId,
  source: 'nrpn',
  channel,
  number,
  mode: 'absolute',
  range: { min: 0, max: 127 },
  invert: false,
  enabled: true,
});

/**
 * Builds the mapping file that PAM imports so that it answers mapuzu's parameter map.
 *
 * @param {object} [options]
 * @param {Iterable<string> | 'all'} [options.params] full parameter ids to map (default `'all'`,
 *   without hosted plug-in parameters)
 * @param {Iterable<string> | 'all'} [options.actions] actions as `name` or `name:cell` (default `'all'`)
 * @param {number} [options.channel] the channel the rows listen on: 0 for any (the default, which
 *   still works under a host that rewrites channels), or the setup's control channel
 * @returns {PamMappingRow[]} sorted by number, one row per target
 */
export function mappingRows({ params = 'all', actions = 'all', channel = 0 } = {}) {
  if (channel !== 0 && !isChannel(channel)) throw new Error(`[pam] mapping channel is ${JSON.stringify(channel)}`);
  const rows = new Map();
  const add = (paramId, number) => rows.set(number, row(paramId, number, channel));

  const wanted = params === 'all' ? listParams().map((p) => p.id) : [...params];
  for (const id of wanted) {
    const param = resolveParam(id);
    if (!param) throw new Error(`[pam] "${id}" is not a full PAM parameter id`);
    add(param.id, paramNumber(param));
  }

  const everyAction = () => {
    const all = [];
    for (const [name, def] of Object.entries(PAM_ACTIONS)) {
      if (!def.action) continue;
      if (!def.cell) all.push(name);
      else for (let c = 1; c <= PAM_CELLS; c++) all.push(`${name}:${c}`);
    }
    return all;
  };
  for (const spec of actions === 'all' ? everyAction() : [...actions]) {
    const [name, cell] = String(spec).split(':');
    const target = actionTarget(name, cell === undefined ? undefined : Number(cell));
    if (!target) throw new Error(`[pam] "${spec}" is not an action mapuzu's map carries`);
    add(target.paramId, target.number);
  }
  return [...rows.values()].sort((a, b) => a.number - b.number);
}

