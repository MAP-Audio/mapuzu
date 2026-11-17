/*
preset.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Reads PAM `.preset` files. Writing goes through `mapcli state --save`, which saves as PAM does.
//
// A preset is the metadata block's byte length in decimal, the metadata JSON, then the state JSON.
// The state's `variations` are one string per slot: "PAMZ1:" + base64 of the zlib-deflated state
// JSON of that slot (plain JSON in presets older than PAM 1.4.61), or "" for an empty slot.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PAM_LANES_PER_CELL } from '../pam/freeze.mjs';

const VARIATION_MARKER = 'PAMZ1:';

/**
 * @param {string | Buffer} source a path, or the file's bytes
 * @returns {{ meta: object, state: object }}
 */
export function readPreset(source) {
  const raw = Buffer.isBuffer(source) ? source : readFileSync(source);
  const brace = raw.indexOf(0x7b);
  const size = Number(raw.subarray(0, Math.max(brace, 0)).toString('latin1'));
  if (brace <= 0 || !Number.isInteger(size) || size <= 0 || brace + size > raw.length) {
    // The CLI also takes a bare state document, or the published { meta, state } form.
    const doc = JSON.parse(raw.toString('utf8'));
    return doc.state && typeof doc.state === 'object' ? { meta: doc.meta ?? {}, state: doc.state } : { meta: {}, state: doc };
  }
  return {
    meta: JSON.parse(raw.subarray(brace, brace + size).toString('utf8')),
    state: JSON.parse(raw.subarray(brace + size).toString('utf8')),
  };
}

/** One slot's state from a `variations` entry, or `undefined` for an empty slot. */
export function decodeVariation(entry) {
  if (typeof entry !== 'string' || entry.length < 8) return undefined;
  const json = entry.startsWith(VARIATION_MARKER)
    ? inflateSync(Buffer.from(entry.slice(VARIATION_MARKER.length), 'base64')).toString('utf8')
    : entry;
  const state = JSON.parse(json);
  return state && typeof state === 'object' ? state : undefined;
}

/**
 * The state of every filled variation slot, keyed by 1-based slot.
 * @param {{ variations?: unknown[] }} state
 * @returns {Map<number, object>}
 */
export function variationStates(state) {
  const out = new Map();
  (state.variations ?? []).forEach((entry, i) => {
    const slot = decodeVariation(entry);
    if (slot) out.set(i + 1, slot);
  });
  return out;
}

/** The slot that a preset opens on, 1-based. */
export const currentSlot = (state) => (Number.isInteger(state.currentVariation) ? state.currentVariation + 1 : 1);

/** The pattern-lane targets that a state already uses, in the form that `freeze`'s `lanes` option takes. */
export function laneTargets(state) {
  const out = {};
  for (const [cell, config] of Object.entries(state.cells ?? {})) {
    for (let lane = 1; lane <= PAM_LANES_PER_CELL; lane++) {
      const target = config?.[`paramLaneTarget${lane}`];
      if (typeof target === 'string' && target !== '') out[`${cell}:${lane}`] = target;
    }
  }
  return out;
}
