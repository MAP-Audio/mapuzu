/*
params.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// PAM's MIDI-mappable parameters: lookup by id, and the value maths that a MIDI mapping applies.
// No Strudel import: this is the engine side that every language binding shares.

import table from './params.generated.mjs';

export const PAM_PRODUCT = table.product;
export const PAM_PARAMETER_VERSION = table.parameterVersion;
export const PAM_CELLS = table.cells;
export const PAM_VARIATIONS = 8;
export const PAM_HOSTED_PER_CELL = table.hostedPerCell;
export const PAM_DRUM_SYNTH_ENGINES = Object.freeze([...table.drumSynthEngines]);
/** Per engine, the MIDI note that it sounds when a poly cell plays its root (null: the engine has no tuned pitch). */
export const PAM_DRUM_SYNTH_NOTES = Object.freeze([...table.drumSynthNotes]);

// A hosted plug-in parameter carries no range hint: PAM treats every one as 0..1.
const HOSTED = Object.freeze({ min: 0, max: 1, skew: 1, step: 0, default: 0, hosted: true });

/**
 * @typedef {object} PamParam
 * @property {string} id full PAM parameter id, e.g. `cell3_filterCutoff`
 * @property {'cell'|'global'|'hosted'} scope
 * @property {number} [cell] 1-based cell, for `cell` and `hosted`
 * @property {string} [suffix] per-cell name without its `cellN_` prefix
 * @property {number} n number inside its scope's block of mapuzu's MIDI map
 * @property {number} min
 * @property {number} max
 * @property {number} skew JUCE skew factor: normalized = proportion ** skew
 * @property {number} step
 * @property {number} default
 * @property {string} [unit]
 * @property {string[]} [labels] enum names, index = value - min
 * @property {string} [group] the effect or module the parameter belongs to
 * @property {string} [label] PAM's display name
 * @property {boolean} [fixed] not a modulation target (no pattern lane, no LFO)
 * @property {boolean} [hidden] absent from PAM's mapping picker, but an imported mapping row still applies
 * @property {boolean} [selector] `variationSelect` / `patternSelect`: slot 1 sits at MIDI value 0
 */

/** Whether `cell` is one of PAM's cells, 1-based. */
export const isCell = (cell) => Number.isInteger(cell) && cell >= 1 && cell <= PAM_CELLS;

/**
 * Finds a parameter by id. Accepts a full id (`cell3_filterCutoff`, `macro_filterCutoff`, `crossfade`,
 * `hosted_p3_12`), or a per-cell name with the cell given apart: `cell_filterCutoff` or `filterCutoff`.
 * A bare name goes to the cell when one is given and has it, else to the global of that name: only
 * `volume` is both, so `volume` on a cell is the cell's fader and without one the master's.
 *
 * @param {string} id
 * @param {number} [cell] the cell a per-cell name belongs to
 * @returns {PamParam | undefined}
 */
export function resolveParam(id, cell) {
  if (typeof id !== 'string' || id === '') return undefined;
  const full = /^cell(\d+)_(.+)$/.exec(id);
  if (full) return cellParam(full[2], Number(full[1]));
  const hosted = /^hosted_p(\d+)_(\d+)$/.exec(id);
  if (hosted) {
    const c = Number(hosted[1]);
    const i = Number(hosted[2]);
    if (!isCell(c) || i >= PAM_HOSTED_PER_CELL) return undefined;
    return { ...HOSTED, id, scope: 'hosted', cell: c, n: i };
  }
  const open = /^cell_(.+)$/.exec(id);
  const name = open ? open[1] : id;
  if (cell !== undefined && cell !== null) {
    const found = cellParam(name, cell);
    if (found || open) return found;
  }
  if (Object.hasOwn(table.global, name)) return { ...table.global[name], id: name, scope: 'global' };
  return undefined;
}

function cellParam(suffix, cell) {
  if (!isCell(cell) || !Object.hasOwn(table.cell, suffix)) return undefined;
  return { ...table.cell[suffix], id: `cell${cell}_${suffix}`, scope: 'cell', cell, suffix };
}

/** True when `name` is a per-cell parameter name (`filterCutoff`), whatever the cell. */
export const isCellParamName = (name) => typeof name === 'string' && Object.hasOwn(table.cell, name);

/**
 * Every parameter, as PAM ids. `cells` narrows the per-cell ones, and `match` filters by id.
 *
 * @param {{ cells?: number[], hosted?: boolean, match?: (id: string, param: PamParam) => boolean }} [options]
 * @returns {PamParam[]}
 */
export function listParams({ cells, hosted = false, match } = {}) {
  const out = [];
  const keep = (p) => {
    if (!match || match(p.id, p)) out.push(p);
  };
  for (const id of Object.keys(table.global)) keep(resolveParam(id));
  const wanted = cells ?? Array.from({ length: PAM_CELLS }, (_, i) => i + 1);
  for (const cell of wanted) {
    for (const suffix of Object.keys(table.cell)) keep(cellParam(suffix, cell));
    if (hosted) for (let i = 0; i < PAM_HOSTED_PER_CELL; i++) keep(resolveParam(`hosted_p${cell}_${i}`));
  }
  return out;
}

/** The per-cell parameter names (`filterCutoff`, `delayMix`, ...), in the table's order. */
export const cellParamNames = () => Object.keys(table.cell);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Reads a pattern value as the parameter's own unit: a number, a numeric string, or an enum label
 * (`"Gate"`, case and spacing ignored). Returns `undefined` for anything else.
 *
 * @param {PamParam} param
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseParamValue(param, value) {
  if (typeof value === 'boolean') return value ? param.max : param.min;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if (!param.labels) return undefined;
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const index = param.labels.findIndex((l) => key(l) === key(trimmed));
  return index < 0 ? undefined : param.min + index;
}

/**
 * The parameter's 0..1 position as JUCE's NormalisableRange computes it: the proportion of the range
 * raised to the skew. Out-of-range values clamp.
 */
export function toNormalized(param, value) {
  if (param.max === param.min) return 0;
  const proportion = clamp((value - param.min) / (param.max - param.min), 0, 1);
  return param.skew === 1 ? proportion : Math.pow(proportion, param.skew);
}

/** The inverse of {@link toNormalized}, snapped to the parameter's step as PAM snaps it. */
export function fromNormalized(param, normalized) {
  const n = clamp(normalized, 0, 1);
  const proportion = param.skew === 1 ? n : Math.pow(n, 1 / param.skew);
  return snap(param, param.min + (param.max - param.min) * proportion);
}

function snap(param, value) {
  if (!(param.step > 0)) return clamp(value, param.min, param.max);
  const stepped = param.min + Math.round((value - param.min) / param.step) * param.step;
  return clamp(stepped, param.min, param.max);
}

/**
 * The 0..127 value that an absolute MIDI mapping with the full 0..127 window needs to arrive at `value`.
 * A selector (variation, pattern) has slot 1 at 0 and its last slot at 127, and no way to say Off.
 */
export function toMidi7(param, value) {
  if (param.selector) {
    if (param.max <= 1) return 0;
    return clamp(Math.round((127 * (value - 1)) / (param.max - 1)), 0, 127);
  }
  return clamp(Math.round(toNormalized(param, value) * 127), 0, 127);
}

/** The value that PAM arrives at when a mapping row receives `midi7` (0..127). */
export function fromMidi7(param, midi7) {
  const n = clamp(midi7, 0, 127) / 127;
  if (param.selector) return snap(param, 1 + n * (param.max - 1));
  return fromNormalized(param, n);
}
