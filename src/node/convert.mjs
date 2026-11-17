/*
convert.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Converts both ways between Strudel and the note lanes of a PAM preset.
//
//   patternToSequences   mini-notation or Strudel code, sampled for N bars -> `cellN_midiSequence`
//   sequencesToStrudel   a state's note lanes -> Strudel code whose mini-notation plays the same notes
//
// The second is exact only for what mini-notation can say on a grid: it reports the grid it found
// per cell and what it left out (chance, micro-timing, the other lanes).

import { freeze } from '../pam/freeze.mjs';
import { createSetup, setupFromState, PAM_DEFAULT_ROOT } from '../pam/midimap.mjs';
import { PAM_CELLS, isCell } from '../pam/params.mjs';
import { DEFAULT_VELOCITY as DEFAULT_LEVEL, midiVelocity } from '../pam/events.mjs';
import { PAM_NOTE_GAP, PAM_SLOW_SPEEDS } from '../pam/freeze.mjs';
import { collect, evaluateStrudel } from './strudel.mjs';
import { currentSlot, decodeVariation, readPreset } from './preset.mjs';

/** PAM's pattern speeds as multiples of the transport, by `patternSpeed` index. */
export const PAM_SPEED_FACTORS = Object.freeze([...[...PAM_SLOW_SPEEDS].reverse().map(([, beats]) => 1 / beats), 4 / 3, 3 / 2, 5 / 3, 2, 3, 4, 5, 6, 8, 12]);

const HIT_WORDS = new Set(['x', 'X', 't', 'T', '1', '0', 'true', 'false']);
const NOTE_WORD = /^[a-gA-G][#bs]*-?\d*$/;

/**
 * How a bare mini-notation string is read: note names are pitches, x/t/1/0 a rhythm, other
 * numbers steps from the cell's root. The numbers that belong to operators (`*8`, `@3`, `(3,8)`)
 * do not count.
 * @returns {'note' | 'hit' | 'n'}
 */
export function miniKind(mini) {
  const bare = String(mini)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[*/@!:?]\s*-?\d*\.?\d*/g, ' ');
  const words = bare.split(/[\s[\]<>,|{}%_]+/).filter((w) => w && w !== '~' && w !== '-' && !/^\.+$/.test(w));
  if (!words.length || words.every((w) => HIT_WORDS.has(w))) return 'hit';
  if (words.every((w) => NOTE_WORD.test(w))) return 'note';
  if (words.every((w) => Number.isFinite(Number(w)))) return 'n';
  throw new Error(`cannot tell what "${mini}" plays: say --as note, n or hit`);
}

const quote = (text) => JSON.stringify(String(text));

/**
 * Samples a pattern for `bars` bars and turns it into PAM note lanes.
 *
 * @param {object} options
 * @param {string} [options.mini] mini-notation for one cell
 * @param {number} [options.cell] the cell `mini` is for
 * @param {'auto' | 'note' | 'n' | 'hit'} [options.as] how to read `mini` (default: `miniKind`)
 * @param {string} [options.code] Strudel code instead of `mini`: everything it plays that names a cell
 * @param {number} options.bars how many bars (cycles) to sample
 * @param {number} [options.beatsPerBar] default 4
 * @param {import('../pam/midimap.mjs').PamSetup} [options.setup] the cells' notes and roots (default: PAM as installed)
 * @returns {Promise<{ delta: object, report: object, problems: string[], code: string }>}
 */
export async function patternToSequences({ mini, cell, as = 'auto', code, bars, beatsPerBar = 4, setup = createSetup() }) {
  if (!(bars > 0)) throw new Error('how many bars? Pass --bars');
  let source = code;
  if (mini !== undefined) {
    if (!isCell(cell)) throw new Error(`which cell is the pattern for? Pass --cell 1-${PAM_CELLS}`);
    const kind = as === 'auto' ? miniKind(mini) : as;
    if (kind === 'hit') source = `s(${quote(cell)}).struct(${quote(mini)})`;
    else if (kind === 'note' || kind === 'n') source = `${kind}(${quote(mini)}).cell(${cell})`;
    else throw new Error(`--as is note, n or hit, not "${as}"`);
  }
  if (!source) throw new Error('nothing to convert: give mini-notation or Strudel code');
  const { pattern } = await evaluateStrudel(source);
  const { timeline, problems } = collect(pattern, { cycles: bars, beatsPerCycle: beatsPerBar, setup, all: true });
  const { delta, report } = freeze(timeline, { beats: bars * beatsPerBar, setup, beatsPerBar, loop: true });
  // Rests for a named cell become a lane with nothing in it. Without that lane the cell would keep its old notes.
  if (mini !== undefined) delta[`cell${cell}_midiSequence`] ??= [];
  return { delta, report, problems, code: source };
}

// ---- PAM sequences -> Strudel ----------------------------------------------------------------

const NAMES = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
const noteName = (midi) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const GRIDS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48];
const near = (v) => Math.abs(v - Math.round(v));

// The coarsest grid (slots per beat) that every time sits on, and the worst miss when none fits.
function gridFor(times, tolerance = 1e-3) {
  for (const g of GRIDS) if (times.every((t) => near(t * g) <= tolerance * g)) return { grid: g, error: 0 };
  const g = GRIDS.at(-1);
  return { grid: g, error: Math.max(...times.map((t) => near(t * g) / g)) };
}

const num = (v) => String(Math.round(v * 100) / 100);
// A speed as code that plays at exactly that speed: a whole number, or the ratio it is ("4/3").
function ratio(v) {
  for (let d = 1; d <= 64; d++) {
    if (Math.abs(v * d - Math.round(v * d)) < 1e-9) return d === 1 ? String(Math.round(v)) : `${Math.round(v * d)}/${d}`;
  }
  return String(v);
}
const weight = (token, slots) => (slots > 1 ? `${token}@${slots}` : token);
const DEFAULT_VELOCITY = midiVelocity(DEFAULT_LEVEL); // what a hap with no velocity freezes to

// A MIDI velocity as the shortest 0..1 number that freezes back to it.
function level(velocity) {
  for (let digits = 1; digits <= 3; digits++) {
    const text = (velocity / 127).toFixed(digits);
    if (Math.round(Number(text) * 127) === velocity) return String(Number(text));
  }
  return String(velocity / 127);
}

// "a a a b" -> "a!3 b": runs of three or more equal steps, where the step carries no weight.
function squeeze(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    while (j < tokens.length && tokens[j] === tokens[i]) j++;
    if (j - i >= 3 && !tokens[i].includes('@')) out.push(`${tokens[i]}!${j - i}`);
    else for (let k = i; k < j; k++) out.push(tokens[i]);
    i = j;
  }
  return out;
}

// One beat of a rhythm as mini-notation: a hit, a rest, or the fewest equal steps that hold its hits.
function beatToken(hits, grid, sym) {
  if (!hits.size) return '~';
  let steps = grid;
  for (let d = 1; d <= grid; d++) {
    if (grid % d === 0 && [...hits.keys()].every((slot) => slot % (grid / d) === 0)) {
      steps = d;
      break;
    }
  }
  const tokens = Array.from({ length: steps }, (_, i) => (hits.has(i * (grid / steps)) ? sym(hits.get(i * (grid / steps))) : '~'));
  return steps === 1 ? tokens[0] : `[${tokens.join(' ')}]`;
}

// A span of `slots` grid slots as one voice per line: notes that overlap go to another voice,
// notes that start and end together at one velocity are a chord.
function voicesOf(notes, slots) {
  const voices = [];
  for (const note of notes) {
    const same = voices.map((v) => v.at(-1)).find((last) => last.start === note.start && last.length === note.length && last.velocity === note.velocity);
    if (same) {
      same.notes.push(note.note);
      continue;
    }
    let voice = voices.find((v) => v.at(-1).start + v.at(-1).length <= note.start);
    if (!voice) voices.push((voice = []));
    voice.push({ start: note.start, length: note.length, notes: [note.note], velocity: note.velocity });
  }
  return voices.map((voice) => {
    const tokens = [];
    let at = 0;
    for (const step of voice) {
      if (step.start > at) tokens.push(weight('~', step.start - at));
      const names = step.notes.map(noteName);
      tokens.push(weight(names.length > 1 ? `[${names.join(',')}]` : names[0], step.length));
      at = step.start + step.length;
    }
    if (at < slots) tokens.push(weight('~', slots - at));
    return { tokens, steps: voice };
  });
}

/**
 * Strudel code that plays a state's note lanes.
 *
 * @param {object} state a preset's state, or one variation's
 * @param {object} [options]
 * @param {number[]} [options.cells] which cells (default: every cell with notes)
 * @param {number} [options.beatsPerBar] default 4
 * @returns {{ code: string, cells: object[] }} `cells` says, per cell, the grid found and what was left out
 */
export function sequencesToStrudel(state, { cells, beatsPerBar = 4 } = {}) {
  const lines = [];
  const reports = [];
  const wiring = setupFromState(state);
  for (let cell = 1; cell <= PAM_CELLS; cell++) {
    if (cells && !cells.includes(cell)) continue;
    const sequence = state[`cell${cell}_midiSequence`];
    if (!Array.isArray(sequence) || !sequence.length) continue;
    const length = Number(state[`cell${cell}_patternLength`] ?? 4);
    const factor = PAM_SPEED_FACTORS[Number(state[`cell${cell}_patternSpeed`] ?? 9)] ?? 1;
    const { poly, note: own, root } = wiring.cells[cell - 1];
    const all = sequence.filter((n) => n.time >= 0 && n.time < length - 1e-9);
    // A mono cell plays only its own note, and a poly cell plays its own note as its root.
    const played = poly ? all.map((n) => (n.note === own ? { ...n, note: root } : n)) : all.filter((n) => n.note === own);
    const report = { cell, notes: played.length, ignored: all.length - played.length, beats: length, speed: factor, chance: played.filter((n) => n.prob !== undefined && n.prob < 1).length };
    reports.push(report);
    if (!played.length) continue;

    const times = played.map((n) => n.time);
    const ends = poly ? played.map((n) => n.time + n.duration + PAM_NOTE_GAP * factor) : [];
    const onsetGrid = gridFor(times);
    const fullGrid = poly ? gridFor([...times, ...ends], 4e-3) : onsetGrid;
    // Note ends that sit on no grid are let go: the notes then last their whole step.
    const { grid, error } = fullGrid.error === 0 ? fullGrid : onsetGrid;
    report.grid = grid;
    if (error > 0) report.quantized = Math.round(error * 1000) / 1000;
    const slotOf = (t) => Math.round(t * grid);
    if (poly && fullGrid.error > 0) report.lengths = 'note lengths sit on no grid: each lasts one step';
    const velocities = played.map((n) => Math.min(127, Math.max(1, Math.round(n.velocity ?? DEFAULT_VELOCITY))));
    const sameVelocity = velocities.every((v) => v === velocities[0]);
    const oneVelocity = velocities[0] === DEFAULT_VELOCITY ? '' : `.velocity(${level(velocities[0])})`;

    const whole = length % beatsPerBar === 0;
    const spans = whole ? length / beatsPerBar : 1;
    const spanBeats = whole ? beatsPerBar : length;
    const cyclesPerSpan = whole ? 1 / factor : length / beatsPerBar / factor;
    // One span's tokens as a step of <>: several need brackets, a lone one carries no weight, and
    // a span of rests is one rest. Without those, "~!4" or "c2@4" would stretch the alternation.
    const step = (tokens) => {
      if (tokens.every((t) => /^~(@\d+)?$/.test(t))) return '~';
      return tokens.length > 1 ? `[${squeeze(tokens).join(' ')}]` : tokens[0].replace(/@\d+$/, '');
    };
    const wrap = (spansOfTokens) =>
      spansOfTokens.length === 1 ? squeeze(spansOfTokens[0]).join(' ').replace(/^(\S+)@\d+$/, '$1') : `<${squeeze(spansOfTokens.map(step)).join(' ')}>`;
    const stretch = Math.abs(cyclesPerSpan - 1) < 1e-9 ? '' : cyclesPerSpan > 1 ? `.slow(${ratio(cyclesPerSpan)})` : `.fast(${ratio(1 / cyclesPerSpan)})`;
    const comment = `// cell ${cell}: ${played.length} notes over ${num(length / factor)} beats${report.chance ? `, chance on ${report.chance} of them not shown` : ''}`;

    if (!poly) {
      const rhythm = [];
      const levels = [];
      for (let span = 0; span < spans; span++) {
        const tokens = [];
        const velTokens = [];
        for (let beat = 0; beat < spanBeats; beat++) {
          const from = (span * spanBeats + beat) * grid;
          const hits = new Map();
          played.forEach((n, i) => {
            const slot = slotOf(n.time) - from;
            if (slot >= 0 && slot < grid) hits.set(slot, velocities[i]);
          });
          tokens.push(beatToken(hits, grid, () => 'x'));
          velTokens.push(beatToken(hits, grid, level));
        }
        rhythm.push(tokens);
        levels.push(velTokens);
      }
      const velocity = sameVelocity ? oneVelocity : `.velocity(${quote(wrap(levels))})`;
      lines.push(comment, `$: s(${quote(cell)}).struct(${quote(wrap(rhythm))})${velocity}${stretch}.pam()`);
      continue;
    }

    const slots = spanBeats * grid;
    const perSpan = Array.from({ length: spans }, () => []);
    let crosses = false;
    played.forEach((n, i) => {
      const start = slotOf(n.time);
      const span = Math.min(spans - 1, Math.floor(start / slots));
      const snapped = Math.max(1, Math.round((n.time + n.duration + PAM_NOTE_GAP * factor) * grid) - start);
      const held = fullGrid.error === 0 ? snapped : 1;
      if (start - span * slots + held > slots) crosses = true;
      perSpan[span].push({ start: start - span * slots, length: held, note: n.note, velocity: velocities[i] });
    });
    if (crosses) report.clipped = 'notes that ring past the bar line end on it';
    const voiceCount = Math.max(...perSpan.map((notes) => voicesOf(notes.map((x) => ({ ...x, length: Math.min(x.length, slots - x.start) })), slots).length));
    for (let v = 0; v < voiceCount; v++) {
      const parts = [];
      const levels = [];
      for (const notes of perSpan) {
        const voice = voicesOf(notes.map((x) => ({ ...x, length: Math.min(x.length, slots - x.start) })), slots)[v];
        parts.push(voice ? voice.tokens : ['~']);
        if (!voice) {
          levels.push(['~']);
          continue;
        }
        const vt = [];
        let at = 0;
        for (const step of voice.steps) {
          if (step.start > at) vt.push(weight('~', step.start - at));
          vt.push(weight(level(step.velocity), step.length));
          at = step.start + step.length;
        }
        if (at < slots) vt.push(weight('~', slots - at));
        levels.push(vt);
      }
      const velocity = sameVelocity ? oneVelocity : `.velocity(${quote(wrap(levels))})`;
      if (v === 0) lines.push(comment);
      lines.push(`$: note(${quote(wrap(parts))}).cell(${cell})${velocity}${stretch}.pam()`);
    }
  }
  return { code: lines.join('\n'), cells: reports };
}

// The pamsetup() call that describes a state's cells, with only what differs from PAM as installed.
function setupCall(state) {
  const setup = setupFromState(state);
  const plain = createSetup();
  const options = [];
  const channels = setup.cells.map((c) => c.channel);
  if (channels.some((c, i) => c !== plain.cells[i].channel)) {
    options.push(channels.every((c, i) => c === i + 1) ? "channels: 'cell'" : `channels: [${channels.join(', ')}]`);
  }
  const notes = setup.cells.map((c) => c.note);
  if (setup.cells.some((c, i) => !c.poly && c.note !== plain.cells[i].note)) options.push(`notes: [${notes.join(', ')}]`);
  const poly = setup.cells.flatMap((c, i) => (c.poly ? [i + 1] : []));
  if (poly.length) {
    options.push(`poly: [${poly.join(', ')}]`);
    if (poly.some((c) => setup.cells[c - 1].root !== PAM_DEFAULT_ROOT)) options.push(`roots: { ${poly.map((c) => `${c}: ${setup.cells[c - 1].root}`).join(', ')} }`);
  }
  return options.length ? `await pamsetup({ ${options.join(', ')} })` : '';
}

/**
 * Strudel code for the note lanes of a preset file.
 *
 * @param {string} path the `.preset`
 * @param {object} [options]
 * @param {number} [options.variation] 1-based slot (default: the one that the preset opens on)
 * @param {number[]} [options.cells]
 * @returns {{ code: string, cells: object[], variation: number, bpm: number }}
 */
export function presetToStrudel(path, { variation, cells } = {}) {
  const { meta, state } = readPreset(path);
  const slot = variation ?? currentSlot(state);
  const slotState = variation === undefined ? state : decodeVariation(state.variations?.[slot - 1]);
  if (!slotState) throw new Error(`variation ${slot} of ${path} is empty`);
  const bpm = Number(meta.bpm ?? state.bpm ?? state.transport?.bpm ?? 120);
  const body = sequencesToStrudel(slotState, { cells });
  const head = [`// @title ${meta.name ?? 'from PAM'} (variation ${slot})`, `setcpm(${num(bpm)}/4)`, setupCall(slotState)].filter(Boolean);
  return { code: `${head.join('\n')}\n\n${body.code}\n`, cells: body.cells, variation: slot, bpm };
}
