/*
page.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The MIDI port of `mapuzu tidal`, as the page it serves runs it: Web MIDI out, with every message
// sent at the time TidalCycles stamped it with. That time is on the system clock and Web MIDI's is
// on the page's own (`performance.now()`), which drifts from it, so the two are lined up here.
// Imports nothing, and takes the browser as an argument so that it can be run without one.

/**
 * @param {object} [env] where `navigator`, `performance` and `Date` are looked up (default `globalThis`)
 */
export function createPort(env = globalThis) {
  let access;
  let output;
  let want;
  let refused;
  let skew;
  const counters = { sent: 0, late: 0, dropped: 0 };

  const pageClock = () => env.performance.timeOrigin + env.performance.now();

  /**
   * Measures the system clock against the page's. `Date.now()` only counts whole milliseconds, so
   * it is read at the moment it ticks over, which takes at most a millisecond of waiting.
   */
  function sync() {
    const from = env.Date.now();
    let now = from;
    for (let i = 0; i < 2e6 && now === from; i++) now = env.Date.now();
    skew = now - pageClock();
    return skew;
  }

  /** Unix milliseconds on the system clock as the `performance.now()` Web MIDI is timed in. */
  function toPerformance(unixMs) {
    if (skew === undefined) sync();
    return unixMs - skew - env.performance.timeOrigin;
  }

  function pick() {
    if (!access) return;
    const outputs = [...access.outputs.values()];
    const name = (want ?? '').toLowerCase();
    if (!name) output = outputs[0];
    else output = outputs.find((o) => o.name === want) ?? outputs.find((o) => o.name?.toLowerCase().includes(name));
    if (output) refused = undefined;
    else if (!outputs.length) refused = 'no MIDI output found: PAM needs a (virtual) MIDI port to listen on';
    else refused = `no MIDI output named "${want}". Found: ${outputs.map((o) => `'${o.name}'`).join(', ')}`;
  }

  return {
    sync,
    toPerformance,
    /** Asks the browser for MIDI, once, and picks the output. */
    async open() {
      if (typeof env.navigator?.requestMIDIAccess !== 'function') {
        refused = 'this browser has no Web MIDI';
        return;
      }
      try {
        access = await env.navigator.requestMIDIAccess({ sysex: false });
        access.onstatechange = pick;
        pick();
      } catch (err) {
        refused = `MIDI was refused: ${err.message}`;
      }
    },
    /** The output to use, by (part of) its name. With no name it is the first one. */
    use(port) {
      want = port === undefined || port === '' ? undefined : String(port);
      pick();
    },
    /**
     * Sends a batch, each message at its time.
     * @param {[number, number[]][]} batch `[unixMs, bytes]`, the system-clock time each is due
     */
    play(batch) {
      for (const [when, bytes] of batch) {
        if (!output) {
          counters.dropped++;
          continue;
        }
        const at = toPerformance(when);
        // Web MIDI sends a message whose time has passed at once: late, and counted.
        if (at < env.performance.now()) counters.late++;
        output.send(bytes, at);
        counters.sent++;
      }
    },
    status() {
      return { port: output?.name, problem: refused, skew, ...counters };
    },
  };
}
