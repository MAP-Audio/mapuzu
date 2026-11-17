/*
gen-pam-params.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Builds src/pam/params.generated.mjs from a PAM product manifest (manifest.json in PAM's repo).
//
//   node scripts/gen-pam-params.mjs /path/to/pam/manifest.json
//
// The table holds what a MIDI mapping can reach: every JUCE parameter (isPluginParameter), with its
// range, skew, step, unit and enum labels, and the number mapuzu's MIDI map gives it. Numbers are
// kept from the table already on disk, so regenerating against a newer manifest only appends.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT = fileURLToPath(new URL('../src/pam/params.generated.mjs', import.meta.url));

const isSelector = (id) => id === 'variationSelect' || /^cell\d+_patternSelect$/.test(id);

// Enum labels are kept unless they only count ("OFF", "1", "2", ...): those add bytes and no names.
function labelsOf(p) {
  const labels = p.strRepr;
  if (!Array.isArray(labels) || labels.length < 2) return undefined;
  if (labels.slice(1).every((l) => /^\d+$/.test(String(l)))) return undefined;
  return labels.map(String);
}

// A parameter keeps the number that the last table gave it, and a new one takes the number after
// the highest ever given. `from` is that mark: it outlives the parameter that had the number.
function number(table, old, from, limit, what) {
  let next = Math.max(from ?? 0, ...Object.values(old).map((e) => (Number.isInteger(e.n) ? e.n + 1 : 0)));
  for (const [id, e] of Object.entries(table)) if (Number.isInteger(old[id]?.n)) e.n = old[id].n;
  for (const e of Object.values(table)) if (!Number.isInteger(e.n)) e.n = next++;
  if (next > limit) throw new Error(`${what}: ${next} numbers do not fit the block of ${limit}`);
  return next;
}

/**
 * The table for a manifest.
 * @param {object} manifest PAM's product manifest
 * @param {object} [previous] the table made last time, whose numbers are kept
 * @returns {object} what src/pam/params.generated.mjs exports
 */
export function buildTable(manifest, previous = {}) {
  const toggleChildren = new Set();
  for (const p of manifest.parameters) {
    if (p.toggleOn) toggleChildren.add(p.toggleOn);
    if (p.toggleOff) toggleChildren.add(p.toggleOff);
  }

  // PAM's own picker rule: which parameters Settings > Mappings offers. A row for any other JUCE
  // parameter still imports and still applies.
  function inPicker(p) {
    if (p.isPluginParameter === false) return false;
    if (p.isModulatable === false && !p.paramId.startsWith('xyControl') && !isSelector(p.paramId)) return false;
    if (p.cell === 'visual') return false;
    if (toggleChildren.has(p.paramId)) return false;
    if (/^pam_combo\d+$/.test(p.paramId)) return false;
    if (p.min === 0 && p.max === 1 && (p.step === 1 || p.step === 0 || p.step === undefined)) return false;
    return true;
  }

  function entry(p) {
    const e = {
      min: p.min,
      max: p.max,
      skew: p.skew ?? 1,
      step: p.step ?? 0,
      default: p.defaultValue,
    };
    if (p.suffix) e.unit = p.suffix;
    const labels = labelsOf(p);
    if (labels) e.labels = labels;
    const group = p.effect ?? p.module;
    if (group) e.group = group;
    if (p.displayName) e.label = p.displayName;
    if (!p.isModulatable) e.fixed = true; // not a modulation target: no pattern lane, no LFO
    if (!inPicker(p)) e.hidden = true; // not offered by PAM's mapping picker, but an imported row still applies
    if (isSelector(p.paramId)) e.selector = true;
    return e;
  }

  const cell = {};
  const global = {};
  const perCell = new Map();
  let hostedPerCell = 0;
  let cellCount = 0;
  for (const p of manifest.parameters) {
    if (p.isPluginParameter === false) continue;
    const hosted = /^hosted_p(\d+)_(\d+)$/.exec(p.paramId);
    if (hosted) {
      hostedPerCell = Math.max(hostedPerCell, Number(hosted[2]) + 1);
      continue;
    }
    const m = /^cell(\d+)_(.+)$/.exec(p.paramId);
    if (m) {
      cellCount = Math.max(cellCount, Number(m[1]));
      if (!perCell.has(m[2])) perCell.set(m[2], new Map());
      perCell.get(m[2]).set(Number(m[1]), p);
      continue;
    }
    global[p.paramId] = entry(p);
  }

  for (const [suffix, byCell] of perCell) {
    const first = JSON.stringify(entry(byCell.get(1)));
    for (let c = 1; c <= cellCount; c++) {
      const p = byCell.get(c);
      if (!p || JSON.stringify(entry(p)) !== first) {
        throw new Error(`cell${c}_${suffix} differs from cell1_${suffix}: the table assumes one shape per suffix`);
      }
    }
    cell[suffix] = JSON.parse(first);
  }

  const nextNumber = {
    cell: number(cell, previous.cell ?? {}, previous.nextNumber?.cell, 1024, 'per-cell parameters'),
    global: number(global, previous.global ?? {}, previous.nextNumber?.global, 1024, 'global parameters'),
  };

  return {
    product: String(manifest.name).toLowerCase(),
    parameterVersion: manifest.parameterVersion,
    cells: cellCount,
    hostedPerCell,
    drumSynthEngines: manifest.drumSynth?.engines ?? [],
    // The MIDI note each engine sounds at a poly cell's root: its tuned centre, where it has one.
    drumSynthNotes: (manifest.drumSynth?.engines ?? []).map((_, i) => {
      const hz = manifest.drumSynth?.engineParams?.[i]?.[0]?.center;
      return hz ? Math.round(69 + 12 * Math.log2(hz / 440)) : null;
    }),
    nextNumber,
    cell,
    global,
  };
}

const header = `/*
params.generated.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Generated by scripts/gen-pam-params.mjs from PAM's manifest.json. Do not edit: regenerate.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error('usage: node scripts/gen-pam-params.mjs <manifest.json>');
    process.exit(2);
  }
  const previous = existsSync(OUT) ? (await import(pathToFileURL(OUT).href)).default : {};
  const out = buildTable(JSON.parse(readFileSync(manifestPath, 'utf8')), previous);
  writeFileSync(OUT, `${header}export default ${JSON.stringify(out)};\n`);
  const perCell = Object.keys(out.cell).length;
  const count = perCell * out.cells + Object.keys(out.global).length + out.hostedPerCell * out.cells;
  console.log(
    `src/pam/params.generated.mjs: ${perCell} per-cell x ${out.cells} cells, ${Object.keys(out.global).length} global, ` +
      `${out.hostedPerCell} hosted per cell = ${count} parameters`,
  );
}
