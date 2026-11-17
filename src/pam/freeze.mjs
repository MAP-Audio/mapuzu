/*
freeze.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Freezing: a finite stretch of PAM events -> the state that PAM's own sequencer needs to play them.
// This is what lets a pattern render offline (mapcli has no MIDI input) and what turns a live
// pattern into a preset that PAM plays on its own.
//
//   notes            -> the cell's note lane (`cellN_midiSequence`), times in beats
//   a cell's knobs   -> its pattern lanes (`cellN_paramLaneKSequence`, four per cell): each step
//                       locks the parameter until the next one
//   mute, solo       -> a lock of the cell's fader at its bottom
//   variation        -> PAM's song (`songMode`): one step per stretch, switching on the bar
//   anything else    -> listed in `report.unsupported`, never dropped in silence
//
// A PAM pattern is at most 32 beats long, so a longer stretch plays at a slower pattern speed:
// 1/32 holds 1024 beats (256 bars of 4/4) in one pass, and note times stay exact, not quantized.

import { heldLength, midiVelocity, resolveNote } from './events.mjs';
import { PAM_CELLS, PAM_VARIATIONS, resolveParam } from './params.mjs';
import { createSetup } from './midimap.mjs';

export const PAM_MAX_PATTERN_BEATS = 32;

/** Beats a frozen note ends before its event does, so that a repeat retriggers. */
export const PAM_NOTE_GAP = 1 / 64;

/** PAM's pattern speeds that slow a pattern down, as [index in `patternSpeed`, beats per pattern beat]. */
export const PAM_SLOW_SPEEDS = Object.freeze([
  [9, 1],
  [8, 2],
  [7, 3],
  [6, 4],
  [5, 5],
  [4, 6],
  [3, 8],
  [2, 12],
  [1, 16],
  [0, 32],
]);

// shared/patternLanes/targetDenylist.json in PAM: parameters that a pattern lane may not lock.
const LANE_DENY = new Set(['pitchShift', 'slice', 'stretch', 'patternSwing', 'patternDirection', 'envAttack', 'envRelease', 'envGain', 'fxRackSplitLoHz', 'fxRackSplitHiHz']);
const LANE_DENY_PREFIX = ['patternLength', 'patternSpeed', 'ccOut', 'patternSelect'];
export const PAM_LANES_PER_CELL = 4;
// A fader locked to its bottom falls about 43 dB per 100 ms and comes back within 30 ms (measured
// on a held note): a mute closes this many seconds ahead of its beat, and opens this many ahead.
const MUTE_CLOSE = 0.1;
const MUTE_OPEN = 0.04;

const laneable = (param) =>
  param.scope === 'cell' && !param.fixed && !LANE_DENY.has(param.suffix) && !LANE_DENY_PREFIX.some((p) => param.suffix.startsWith(p));

const round = (v) => Math.round(v * 1e6) / 1e6;

/**
 * The pattern clock that holds `beats` beats in one pass: the fastest speed whose 32 pattern beats
 * reach that far, and the pattern length at that speed.
 * @returns {{ speed: number, slow: number, length: number }}
 */
export function patternClock(beats) {
  for (const [speed, slow] of PAM_SLOW_SPEEDS) {
    if (PAM_MAX_PATTERN_BEATS * slow >= beats - 1e-9) {
      return { speed, slow, length: Math.min(PAM_MAX_PATTERN_BEATS, Math.max(1, Math.ceil(beats / slow - 1e-9))) };
    }
  }
  const max = PAM_MAX_PATTERN_BEATS * PAM_SLOW_SPEEDS.at(-1)[1];
  throw new Error(`[pam] ${beats} beats do not fit one PAM pattern: the longest is ${max} beats`);
}

// The clock whose pattern is exactly `beats` long, so that it loops where the stretch does.
function loopClock(beats) {
  for (const [speed, slow] of PAM_SLOW_SPEEDS) {
    const length = beats / slow;
    if (length <= PAM_MAX_PATTERN_BEATS + 1e-9 && Math.abs(length - Math.round(length)) < 1e-9 && length >= 1) {
      return { speed, slow, length: Math.round(length) };
    }
  }
  throw new Error(`[pam] ${beats} beats cannot loop in PAM: a pattern is a whole number of beats, at most 32, at one of PAM's speeds`);
}

/**
 * @typedef {object} TimelineEntry
 * @property {number} beat onset in quarter notes from the start
 * @property {number} beats length in quarter notes
 * @property {import('./events.mjs').PamEvent[]} events from `compileValue`
 */

/**
 * @typedef {object} Frozen
 * @property {Record<string, unknown>} delta the state delta: apply it to every variation the song plays
 * @property {object | null} song the `songMode` to add once, or null when the timeline never switches variation
 * @property {number[]} slots the variation slots the song plays, 1-based (empty without a song)
 * @property {object} report what went where, and `unsupported`: what could not be frozen and why
 */

/**
 * Freezes a timeline.
 *
 * @param {TimelineEntry[]} timeline
 * @param {object} options
 * @param {number} options.beats the stretch's length in beats
 * @param {import('./midimap.mjs').PamSetup} [options.setup] the cells' notes and roots, as for live MIDI
 * @param {number} [options.beatsPerBar] default 4
 * @param {number} [options.bpm] tempo, for the lead a mute needs in real time (default 120)
 * @param {number} [options.gap] beats a note ends before its event does (default 1/64)
 * @param {number} [options.variation] the variation that plays before the first switch (default 1)
 * @param {Record<string, string>} [options.lanes] pattern-lane targets that the preset already uses, keyed `cell:lane`
 * @param {boolean} [options.loop] make the lanes exactly `beats` long, to loop in PAM. The default is
 *   a stretch played once: its lanes run a bar longer than it, so that a lock held to the end (a
 *   mute, a knob's last value) is still held through a render's tail instead of letting go there
 * @returns {Frozen}
 */
export function freeze(timeline, { beats, setup = createSetup(), beatsPerBar = 4, bpm = 120, gap = PAM_NOTE_GAP, variation = 1, lanes: taken = {}, loop = false } = {}) {
  if (!(beats > 0)) throw new Error('[pam] freeze needs the length in beats');
  const clock = loop ? loopClock(beats) : patternClock(beats + beatsPerBar);
  const toPattern = (b) => round(b / clock.slow);
  const clockBeats = clock.length * clock.slow;
  const delta = {};
  const cellsPatch = {};
  const report = { beats, clock, cells: {}, static: [], song: null, unsupported: [] };
  const unsupported = (what, reason) => {
    if (!report.unsupported.some((u) => u.what === what)) report.unsupported.push({ what, reason });
  };
  const cellReport = (cell) => (report.cells[cell] ??= { notes: 0, lanes: [] });

  const notes = new Map(); // cell -> lane events
  const knobs = new Map(); // param id -> { param, steps: [{ beat, value }] }
  const switches = new Map(); // `${what}:${cell}` -> [{ beat, on }]
  const variations = [];
  const sorted = [...timeline].filter((e) => e.beat < beats - 1e-9).sort((a, b) => a.beat - b.beat);

  for (const entry of sorted) {
    for (const event of entry.events) {
      switch (event.type) {
        case 'note': {
          const length = Math.min(entry.beats, beats - entry.beat);
          const list = notes.get(event.cell) ?? notes.set(event.cell, []).get(event.cell);
          list.push({
            time: toPattern(entry.beat),
            duration: toPattern(heldLength(length, gap)),
            note: resolveNote(event, setup.cells[event.cell - 1]),
            velocity: midiVelocity(event.velocity),
          });
          break;
        }
        case 'knob': {
          const k = knobs.get(event.param.id) ?? knobs.set(event.param.id, { param: event.param, steps: [] }).get(event.param.id);
          const last = k.steps.at(-1);
          if (last && Math.abs(last.beat - entry.beat) < 1e-9) last.value = event.value;
          else if (!last || last.value !== event.value) k.steps.push({ beat: entry.beat, value: event.value });
          break;
        }
        case 'switch': {
          const key = `${event.what}:${event.cell}`;
          (switches.get(key) ?? switches.set(key, []).get(key)).push({ beat: entry.beat, on: event.on });
          break;
        }
        case 'press': {
          if (event.name === 'mute' || event.name === 'solo') {
            const key = `${event.name}:${event.cell}`;
            const list = switches.get(key) ?? switches.set(key, []).get(key);
            list.push({ beat: entry.beat, on: !(list.at(-1)?.on ?? false) });
          } else if (event.name === 'trigger') {
            const list = notes.get(event.cell) ?? notes.set(event.cell, []).get(event.cell);
            list.push({ time: toPattern(entry.beat), duration: toPattern(0.25), note: resolveNote({}, setup.cells[event.cell - 1]), velocity: 120 });
          } else {
            unsupported(`press ${event.name}`, 'an action of the running plug-in: nothing in a preset plays it');
          }
          break;
        }
        case 'variation':
          variations.push({ beat: entry.beat, index: event.index });
          break;
        case 'preset':
          unsupported('progNum', 'a preset change is live only: render each preset on its own');
          break;
        case 'cc':
        case 'nrpn':
          unsupported(event.type === 'cc' ? `cc ${event.cc}` : `nrpn ${event.number}`, 'what a plain controller does depends on the mappings of the PAM that hears it');
          break;
        default:
          break; // transport: a render starts at the top by itself
      }
    }
  }

  // Notes: one lane per cell, on the stretch's clock, with swing and direction neutral so that the
  // notes play at the times written.
  for (const [cell, list] of [...notes].sort((a, b) => a[0] - b[0])) {
    delta[`cell${cell}_midiSequence`] = list;
    delta[`cell${cell}_patternLength`] = clock.length;
    delta[`cell${cell}_patternSpeed`] = clock.speed;
    delta[`cell${cell}_patternSwing`] = 0;
    delta[`cell${cell}_patternDirection`] = 0;
    // A poly cell's sequencer plays its own note as the root, whatever the root is, so keep the two equal.
    const c = setup.cells[cell - 1];
    cellsPatch[cell] = { ...cellsPatch[cell], stepPropertyMode: 0, ...(c.poly ? { midiNote: c.root } : {}) };
    cellReport(cell).notes = list.length;
  }

  // Mute and solo: a cell is silent while muted, or while another cell is soloed and it is not.
  const silences = silentSpans(switches, beats);
  for (const [cell, spans] of silences) {
    if (!spans.length) continue;
    const fader = resolveParam('volume', cell);
    const id = fader.id;
    if (knobs.has(id)) {
      unsupported(`mute/solo of cell ${cell}`, `its fader (${id}) is also patterned: one lane cannot do both`);
      continue;
    }
    // The lock starts and ends early, so the first hit of a muted bar is silent and the first
    // hit after it is whole.
    const close = (b) => Math.max(0, b - (MUTE_CLOSE * bpm) / 60);
    const open = (b) => Math.max(0, b - (MUTE_OPEN * bpm) / 60);
    knobs.set(id, { param: fader, locks: spans.map(([from, to]) => ({ beat: close(from), value: fader.min, until: to >= beats ? clockBeats : open(to) })) });
  }

  // Knobs: a lane per changing per-cell parameter, a plain value for one that never moves.
  const lanesUsed = new Map();
  for (const [key, target] of Object.entries(taken)) {
    const cell = Number(key.split(':')[0]);
    if (target) (lanesUsed.get(cell) ?? lanesUsed.set(cell, new Map()).get(cell)).set(Number(key.split(':')[1]), target);
  }
  for (const { param, steps, locks } of knobs.values()) {
    const constant = !locks && steps.length === 1 && steps[0].beat < 1e-9;
    if (constant) {
      delta[param.id] = steps[0].value;
      report.static.push(param.id);
      continue;
    }
    if (!laneable(param)) {
      if (!locks && new Set(steps.map((s) => s.value)).size === 1) {
        unsupported(param.id, `set once at beat ${round(steps[0].beat)}: only a value from the first beat can be frozen for a parameter with no pattern lane`);
      } else {
        unsupported(param.id, param.scope === 'cell' ? 'PAM allows no pattern lane on this parameter' : 'only a cell\'s own parameters have pattern lanes: this one moves live only');
      }
      continue;
    }
    const used = lanesUsed.get(param.cell) ?? lanesUsed.set(param.cell, new Map()).get(param.cell);
    let lane = [...used].find(([, target]) => target === param.suffix)?.[0];
    if (lane === undefined) {
      for (let k = 1; k <= PAM_LANES_PER_CELL && lane === undefined; k++) if (!used.has(k)) lane = k;
    }
    if (lane === undefined) {
      unsupported(param.id, `cell ${param.cell} has no free pattern lane: PAM gives a cell ${PAM_LANES_PER_CELL}`);
      continue;
    }
    used.set(lane, param.suffix);
    const events = locks
      ? locks.map((l) => ({ time: toPattern(l.beat), value: l.value, duration: toPattern(l.until - l.beat) }))
      : steps.map((s, i) => ({ time: toPattern(s.beat), value: s.value, duration: toPattern((steps[i + 1]?.beat ?? clockBeats) - s.beat) }));
    delta[`cell${param.cell}_paramLane${lane}Sequence`] = events;
    delta[`cell${param.cell}_patternLengthParam${lane}`] = clock.length;
    delta[`cell${param.cell}_patternSpeedParam${lane}`] = clock.speed;
    cellsPatch[param.cell] = { ...cellsPatch[param.cell], [`paramLaneTarget${lane}`]: param.suffix };
    cellReport(param.cell).lanes.push({ lane, target: param.suffix, steps: events.length });
  }

  if (Object.keys(cellsPatch).length) delta.cells = Object.fromEntries(Object.entries(cellsPatch).map(([c, patch]) => [String(c), patch]));

  const { song, slots } = songFor(variations, { beats, beatsPerBar, variation });
  report.song = song ? song.steps.map((s) => ({ bars: [s.startPositionBars, s.endPositionBars], variation: s.variationIndex + 1 })) : null;
  return { delta, song, slots, report };
}

// Per cell, the [from, to) beat spans in which it is silent.
function silentSpans(switches, beats) {
  const out = new Map();
  if (!switches.size) return out;
  const edges = new Set([0, beats]);
  for (const list of switches.values()) for (const s of list) edges.add(s.beat);
  const times = [...edges].filter((t) => t >= 0 && t <= beats).sort((a, b) => a - b);
  const stateAt = (key, t) => {
    let on = false;
    for (const s of switches.get(key) ?? []) if (s.beat <= t + 1e-9) on = s.on;
    return on;
  };
  for (let cell = 1; cell <= PAM_CELLS; cell++) {
    const spans = [];
    for (let i = 0; i < times.length - 1; i++) {
      const t = times[i];
      let anySolo = false;
      for (let c = 1; c <= PAM_CELLS; c++) anySolo ||= stateAt(`solo:${c}`, t);
      const silent = stateAt(`mute:${cell}`, t) || (anySolo && !stateAt(`solo:${cell}`, t));
      if (!silent) continue;
      if (spans.length && Math.abs(spans.at(-1)[1] - t) < 1e-9) spans.at(-1)[1] = times[i + 1];
      else spans.push([t, times[i + 1]]);
    }
    out.set(cell, spans);
  }
  return out;
}

/**
 * PAM's song for a list of variation switches: each lands on the next bar line, as a live switch
 * does, cuts with no morph and leaves the patterns' phase alone.
 */
export function songFor(switches, { beats, beatsPerBar = 4, variation = 1 }) {
  if (!switches.length) return { song: null, slots: [] };
  const bars = Math.max(1, Math.ceil(beats / beatsPerBar - 1e-9));
  const stretches = [];
  let current = variation;
  let from = 0;
  for (const s of [...switches].sort((a, b) => a.beat - b.beat)) {
    if (s.index < 1 || s.index > PAM_VARIATIONS) continue;
    const bar = Math.min(bars, Math.max(0, Math.ceil(s.beat / beatsPerBar - 1e-9)));
    if (s.index === current) continue;
    if (bar > from) stretches.push({ from, to: bar, index: current });
    current = s.index;
    from = bar;
  }
  if (bars > from) stretches.push({ from, to: bars, index: current });

  const cut = { morphBars: 0, transition: { audio: { tail: 'cut' }, phase: 'continue' } };
  const nodes = stretches.map((s, i) => ({
    id: `n${i + 1}`,
    variationIndex: s.index - 1,
    durationBars: s.to - s.from,
    repeatCount: 1,
    probability: 1,
    muted: false,
    x: round(0.1 + (0.8 * (i % 8)) / 7),
    y: round(0.2 + 0.2 * Math.floor(i / 8)),
  }));
  const connections = nodes.slice(1).map((n, i) => ({ fromId: nodes[i].id, toId: n.id, ...cut }));
  const steps = stretches.map((s, i) => ({
    startPositionBars: s.from,
    endPositionBars: s.to,
    variationIndex: s.index - 1,
    muted: false,
    ...(i > 0 ? { morphPhase: 'continue', morphTail: 'cut' } : {}),
  }));
  return {
    song: { nodes, connections, stepNodeIds: nodes.map((n) => n.id), steps, routeSeed: 1 },
    slots: [...new Set(stretches.map((s) => s.index))].sort((a, b) => a - b),
  };
}
