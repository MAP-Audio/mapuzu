/*
follow.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Following PAM's clock output: PAM owns the timeline, and a pattern is played
// on it. This module is the arithmetic only. It uses no Strudel, no socket and no clock of its own:
// it is told each snapshot that PAM publishes and each hap about to be sent, and answers with where
// the pattern should be read from and how fast the scheduler should run.
//
// Two corrections, because a scheduler that cannot seek leaves only two:
//   position  a number of cycles added to the time the pattern is queried at. It moves in one step,
//             when PAM starts, seeks or loops (a new epoch) or the pattern and PAM have come apart.
//   tempo     PAM's own, trimmed by a few percent to close what is left, a few milliseconds.

/** Where PAM serves its clock by default. */
export const CLOCK_FEED_URL = 'http://127.0.0.1:9836/clock';

/** The snapshot version that this module reads. */
export const CLOCK_VERSION = 1;

// A position is kept on a grid that a double holds exactly, so shifting a query there and back is exact.
const GRID = 65536;
const onGrid = (cycles) => Math.round(cycles * GRID) / GRID;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @typedef {object} ClockSnapshot one instant of PAM's transport: the start of one audio block
 * @property {number} epoch increments on every discontinuity: start, stop, seek, loop, a change of timeline
 * @property {boolean} playing
 * @property {number} ppq quarter notes from the start of the timeline
 * @property {number} bpm
 * @property {number} quartersPerBar from the time signature
 * @property {number} unixMs wall-clock time of that instant, in milliseconds
 * @property {string} [source] `host`, `standalone` or `offline`
 * @property {string} [instance] which PAM, when several run
 */

/**
 * Reads one snapshot off the wire.
 * @param {unknown} data the parsed JSON of one feed message
 * @returns {ClockSnapshot}
 * @throws when a field that a follower needs is missing or not a number
 */
export function readSnapshot(data) {
  if (data === null || typeof data !== 'object') throw new Error('a clock snapshot is an object');
  if (data.version !== CLOCK_VERSION) throw new Error(`clock snapshot version ${JSON.stringify(data.version)}: this reads version ${CLOCK_VERSION}`);
  for (const key of ['epoch', 'ppq', 'bpm', 'unixMs']) {
    if (!isNumber(data[key])) throw new Error(`clock snapshot: ${key} is ${JSON.stringify(data[key])}`);
  }
  if (!(data.bpm > 0)) throw new Error(`clock snapshot: bpm is ${data.bpm}`);
  const [numerator, denominator] = Array.isArray(data.timeSig) ? data.timeSig : [4, 4];
  if (!(numerator > 0) || !(denominator > 0)) throw new Error(`clock snapshot: timeSig is ${JSON.stringify(data.timeSig)}`);
  return {
    epoch: data.epoch,
    playing: data.playing === true,
    ppq: data.ppq,
    bpm: data.bpm,
    quartersPerBar: (numerator * 4) / denominator,
    unixMs: data.unixMs,
    source: typeof data.source === 'string' ? data.source : undefined,
    instance: typeof data.instance === 'string' ? data.instance : undefined,
  };
}

/**
 * Follows one PAM.
 *
 * @param {object} [options]
 * @param {number} [options.quartersPerCycle] quarter notes in one cycle (default: one bar of PAM's time signature)
 * @param {number} [options.jump] seconds apart at which the position moves in one step instead of the tempo closing it (default 0.04)
 * @param {number} [options.gain] share of the remaining error closed per second by the tempo (default 0.5)
 * @param {number} [options.maxTrim] most the tempo may differ from PAM's, as a fraction (default 0.03)
 * @param {number} [options.staleMs] a playing PAM that has sent nothing for this long is not followed (default 2000)
 */
export function createFollower(options = {}) {
  const { quartersPerCycle, jump = 0.04, gain = 0.5, maxTrim = 0.03, staleMs = 2000 } = options;
  /** @type {ClockSnapshot | undefined} */
  let snapshot;
  let receivedMs = 0;
  let offset = 0;
  let version = 0;
  let anchoredEpoch;
  let trim = 0;
  let errorMs;
  let jumps = 0;

  const quarters = () => quartersPerCycle ?? snapshot.quartersPerBar;
  const pamCps = () => snapshot.bpm / 60 / quarters();
  const tempo = () => pamCps() * (1 + trim);
  // A bounce does not run in real time: PAM reports where it is, but nothing can be timed against it.
  const followable = () => snapshot !== undefined && snapshot.source !== 'offline';

  /** PAM's position in cycles at a wall-clock time. */
  function cycleAt(unixMs) {
    const ppq = snapshot.playing ? snapshot.ppq + ((unixMs - snapshot.unixMs) / 60000) * snapshot.bpm : snapshot.ppq;
    return ppq / quarters();
  }

  return {
    /**
     * @param {ClockSnapshot} next
     * @param {number} nowMs wall-clock time it arrived
     */
    onSnapshot(next, nowMs) {
      snapshot = next;
      receivedMs = nowMs;
    },

    /** The tempo for the scheduler now, in cycles per second, or nothing before PAM has been heard. */
    cps() {
      return followable() ? tempo() : undefined;
    },

    /** What a query adds to its time, and a tag for the haps that it returns. */
    position() {
      return { offset, version };
    },

    /**
     * One hap about to be sent.
     * @param {object} hap
     * @param {number} hap.cycle where it sits on the pattern's timeline: its onset plus the offset it was queried with
     * @param {number} hap.unixMs when PAM will hear it
     * @param {number} hap.version the tag `position()` gave when it was queried
     * @param {number} hap.cps the scheduler's tempo when it was scheduled
     * @param {number} [hap.nowMs] wall-clock time now (default: `unixMs`, a hap due at once)
     * @returns {{ cps: number, astray: boolean } | undefined} cycles per second for the scheduler, and
     *   whether this hap was read from a position that PAM has since left (it should not sound).
     *   Returns nothing while there is no PAM to follow
     */
    onHap({ cycle, unixMs, version: queried, cps, nowMs = unixMs }) {
      if (!followable()) return undefined;
      if (snapshot.playing && nowMs - receivedMs > staleMs) return undefined;
      // A hap queried before the last move still carries the old position, so it says nothing about now.
      if (queried !== version) return { cps: tempo(), astray: true };
      if (!snapshot.playing) {
        trim = 0;
        errorMs = undefined;
        return { cps: pamCps(), astray: false };
      }
      const cycles = cycleAt(unixMs) - cycle;
      const seconds = cycles / pamCps();
      errorMs = seconds * 1000;
      const moved = anchoredEpoch !== snapshot.epoch || Math.abs(seconds) > jump;
      // A hap scheduled at another tempo is timed by that tempo, so the position waits for a hap scheduled at PAM's.
      if (moved && Math.abs(cps / pamCps() - 1) > maxTrim + 1e-6) return { cps: pamCps(), astray: true };
      if (moved) {
        offset = onGrid(offset + cycles);
        version++;
        jumps++;
        anchoredEpoch = snapshot.epoch;
        trim = 0;
      } else {
        trim = Math.round(clamp(seconds * gain, -maxTrim, maxTrim) * 1e4) / 1e4;
      }
      return { cps: tempo(), astray: moved };
    },

    /** For `pamstatus()`. */
    status() {
      if (!snapshot) return { following: false };
      return {
        following: true,
        epoch: snapshot.epoch,
        playing: snapshot.playing,
        bpm: snapshot.bpm,
        source: snapshot.source,
        instance: snapshot.instance,
        offset,
        jumps,
        trim,
        errorMs,
      };
    },
  };
}
