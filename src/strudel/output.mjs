/*
output.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `.pam()`: sends a pattern to a running PAM as MIDI, timed to each hap's onset. It is shaped like
// `.midi()`. The encoding is in src/pam, and this file holds only the MIDI output and the clock.
//
// Nothing here imports Strudel: `createOutput` is handed the core whose `Pattern` it extends, which
// is the npm package under Node and the page's own copy on strudel.cc.

import { compileValue } from '../pam/events.mjs';
import { createMidiEncoder } from '../pam/midi.mjs';
import { createSetup } from '../pam/midimap.mjs';
import { CLOCK_FEED_URL, createFollower, readSnapshot } from '../pam/follow.mjs';

const isClockTick = (event) => event.type === 'transport' && event.command === 'clock';
// How long `pamsetup({ follow })` waits for PAM's first clock snapshot before it gives up waiting.
const FIRST_SNAPSHOT_MS = 3000;

/**
 * Makes the output for one copy of Strudel's core.
 *
 * @param {{ Pattern: Function, isPattern: Function, logger: Function, midicmd: Function }} core
 * @param {object} [env] where `navigator`, `performance`, `EventSource`, `getAudioContext` and
 *   the REPL's `setcps` are looked up, each time they are needed (default `globalThis`)
 */
export function createOutput({ Pattern, isPattern, logger, midicmd }, env = globalThis) {
  /**
   * Defaults for `.pam()`, which `pamsetup` changes.
   * `port` picks a MIDI output by (part of) its name, `latency` shifts every message in seconds.
   */
  const pamDefaults = { port: undefined, latency: 0 };

  let setupOptions = {};
  let setup = createSetup();
  const links = new Map(); // port name -> { encoder, output, ready, channels, clocked }
  const reported = new Set();
  let midiAccess;
  let injected; // an output handed to pamsetup({ output }), for Node and for tests
  let counters = { sent: 0, dropped: 0, astray: 0 };
  let clock; // { url, follower, source, ready } while following PAM's clock output
  let tick = []; // the haps fired since the last send, as pamTrigger's arguments
  // The mutes and solos that the player said PAM holds. They are applied to an encoder when it is
  // made, and again each time the player says them.
  const held = { mute: undefined, solo: undefined };

  function report(message, type = 'warning') {
    if (reported.has(message)) return;
    reported.add(message);
    logger(`[pam] ${message}`, type);
  }

  const hasWebMidi = () => typeof env.navigator?.requestMIDIAccess === 'function';

  /**
   * Describes the PAM being played and where its MIDI goes, and opens the MIDI port. Call it
   * once, before the patterns, and wait for it: `await pamsetup()`. With no call, `.pam()` assumes
   * PAM as installed (every cell on channel 1, notes 48-55) and opens the port at the first note,
   * which is too late for that note.
   *
   * @name pamsetup
   * @param {object} [options]
   * @param {string} [options.port] MIDI output to use, by (part of) its name. The default is the first one
   * @param {number} [options.latency] seconds added to every message, to line PAM up with other outputs
   * @param {'cell' | number | number[]} [options.channels] each cell's MIDI channel. `'cell'` puts
   *   cell N on channel N, which a preset needs to play several cells by pitch
   * @param {number[]} [options.notes] each cell's trigger note (default 48-55)
   * @param {number | number[]} [options.roots] each poly cell's root note (default 48)
   * @param {number[]} [options.poly] the cells that are poly or slice-keymapped
   * @param {Record<string, number>} [options.names] sound names for `s`, e.g. `{ bd: 1, sd: 2, hh: 3 }`
   * @param {number} [options.control] channel for mapuzu's parameter map (default 16)
   * @param {'automap' | object} [options.cc] parameters to send as a plain CC, learned by hand in PAM
   * @param {object} [options.listeners] PAM's fixed listeners, where they were changed from the default
   * @param {number[]} [options.muted] the cells that are muted in PAM right now. PAM's MIDI can only
   *   toggle a mute, so the output keeps count from "nothing muted": pass this after muting by hand
   * @param {number[]} [options.soloed] the same for solo
   * @param {boolean | string} [options.follow] play on PAM's timeline: `true` reads PAM's clock
   *   output where PAM serves it by default, a URL (in single quotes) reads it from there, `false` stops
   * @param {{ send: (bytes: number[], timestamp?: number) => void }} [options.output] a MIDI output
   *   to use as it is (outside the browser, where there is no Web MIDI)
   * @returns {Promise<object>} what `pamstatus()` returns, once the port is open and, when
   *   following, PAM's clock has been heard
   * @example
   * await pamsetup({ port: 'IAC Driver Bus 1', channels: 'cell', poly: [5, 8], names: { bd: 1, sd: 2, hh: 3 } })
   */
  function pamsetup(options = {}) {
    const { output, ...said } = options;
    const { port, latency, muted, soloed, follow, ...rest } = plain(said);
    setup = createSetup(rest);
    setupOptions = rest;
    if (port !== undefined) pamDefaults.port = String(port);
    if (latency !== undefined) pamDefaults.latency = Number(latency) || 0;
    if (output !== undefined) injected = output;
    if (muted !== undefined) held.mute = new Set(muted);
    if (soloed !== undefined) held.solo = new Set(soloed);
    // A song file calls this on every evaluation, so the encoders keep what they sent, mutes above all.
    for (const link of links.values()) {
      link.encoder.use(setup);
      if (output !== undefined) link.output = output;
      assumeHeld(link.encoder, { mute: muted !== undefined, solo: soloed !== undefined });
    }
    reported.clear();
    if (follow !== undefined) setFollow(follow);
    const waits = [];
    // Where there is no MIDI to open (a render in Node), the error is not reported until a note needs the port.
    if (injected || hasWebMidi()) {
      // A port that was not there at an earlier setup (the bus was off, access was refused) is looked for again.
      for (const [key, link] of links) if (!link.output && !link.opening) open(link, key || undefined);
      waits.push(linkFor(pamDefaults.port).ready);
    }
    if (clock) waits.push(clock.ready);
    return Promise.all(waits).then(pamstatus);
  }

  /**
   * What the output is doing: the setup, each port's connection, messages sent, haps dropped for
   * want of a port or left out because PAM had moved on (`astray`), and PAM's clock while it is followed.
   * @name pamstatus
   */
  function pamstatus() {
    return {
      setup,
      options: setupOptions,
      ports: [...links.entries()].map(([port, link]) => ({ port: port || '(first output)', connected: Boolean(link.output), name: link.output?.name })),
      ...counters,
      problems: [...reported],
      ...(clock ? { clock: { url: clock.url, ...clock.follower.status() } } : {}),
    };
  }

  function assumeHeld(encoder, which = { mute: true, solo: true }) {
    for (const what of ['mute', 'solo']) {
      if (!which[what] || !held[what]) continue;
      for (let cell = 1; cell <= setup.cells.length; cell++) encoder.assume(what, cell, held[what].has(cell));
    }
  }

  // In the REPL a double-quoted string arrives as a mini-notation pattern, wherever it sits in the
  // arguments (`{ channels: "cell" }` too): take each back to what was typed, a number or the words.
  function plain(value) {
    if (isPattern(value)) {
      const typed = value.queryArc(0, 1).map((hap) => hap.value);
      return typed.length === 1 ? typed[0] : typed.join(' ');
    }
    if (Array.isArray(value)) return value.map(plain);
    if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
    }
    return value;
  }

  async function findOutput(port) {
    if (!hasWebMidi()) throw new Error('no Web MIDI here: pass a MIDI output to pamsetup({ output })');
    midiAccess ??= await env.navigator.requestMIDIAccess({ sysex: false });
    const outputs = [...midiAccess.outputs.values()];
    if (!outputs.length) throw new Error('no MIDI output found: PAM needs a (virtual) MIDI port to listen on');
    if (port === undefined || port === '') return outputs[0];
    const want = port.toLowerCase();
    const found = outputs.find((o) => o.name === port) ?? outputs.find((o) => o.name?.toLowerCase().includes(want));
    if (!found) throw new Error(`no MIDI output named "${port}". Found: ${outputs.map((o) => `'${o.name}'`).join(', ')}`);
    return found;
  }

  // Web MIDI answers later: haps that fire before it does are dropped, never sent late.
  function open(link, port) {
    link.opening = true;
    link.ready = findOutput(port)
      .then((output) => {
        link.output = output;
        logger(`[pam] MIDI out: ${output.name}`);
      })
      .catch((err) => report(`${err.message}`, 'error'))
      .finally(() => (link.opening = false));
  }

  function linkFor(port, encoderOptions) {
    const key = port ?? '';
    let link = links.get(key);
    if (!link) {
      link = { encoder: createMidiEncoder(setup, encoderOptions), output: injected, channels: new Set(), clocked: false };
      assumeHeld(link.encoder);
      links.set(key, link);
      if (injected) link.ready = Promise.resolve();
      else open(link, port);
    }
    return link;
  }

  // Starts, keeps or stops reading PAM's clock output. A song file passes `follow` on every
  // evaluation, so the same URL keeps its follower and the position it has found.
  function setFollow(follow) {
    const url = follow === true ? CLOCK_FEED_URL : follow ? String(follow) : undefined;
    if (clock?.url === url) return;
    clock?.source.close();
    clearTimeout(clock?.timer);
    clock = undefined;
    if (!url) return;
    if (typeof env.EventSource !== 'function') {
      report('no EventSource here: following PAM needs a browser', 'error');
      return;
    }
    const follower = createFollower();
    const source = new env.EventSource(url);
    let heard;
    const ready = new Promise((resolve) => (heard = resolve));
    const timer = setTimeout(() => {
      report(`no clock from PAM at ${url}: is PAM running with its clock output on?`, 'error');
      heard();
    }, FIRST_SNAPSHOT_MS);
    source.onmessage = (message) => {
      try {
        follower.onSnapshot(readSnapshot(JSON.parse(message.data)), wallClock(env.performance.now()));
        setCps(follower.cps());
        clearTimeout(timer);
        heard();
      } catch (err) {
        report(err.message, 'error');
      }
    };
    clock = { url, follower, source, ready, timer };
  }

  const wallClock = (performanceMs) => env.performance.timeOrigin + performanceMs;

  // Audio-clock seconds -> the performance.now() milliseconds that Web MIDI timestamps are in. Where
  // an audio context is in reach (the REPL's `getAudioContext`), the context pairs the two clocks
  // itself, which avoids the render-quantum jitter of reading `currentTime`. Elsewhere `currentTime`
  // counts as now.
  function midiTime(targetTime, currentTime) {
    let stamp;
    try {
      stamp = env.getAudioContext?.()?.getOutputTimestamp?.();
    } catch {
      stamp = undefined;
    }
    if (stamp?.performanceTime != null && stamp?.contextTime != null) {
      return stamp.performanceTime + (targetTime - stamp.contextTime) * 1000;
    }
    return env.performance.now() + (targetTime - currentTime) * 1000;
  }

  // The messages that start PAM's transport with a clock tick: Start at cycle 0, as @strudel/midi
  // sends, or a song position and Continue when the clock joins later, which it can only do on a
  // sixteenth.
  function clockStart(link, hap, cycle) {
    const tick = Math.round(cycle / Number(hap.duration));
    if (tick === 0) return [[0xfa]];
    if (link.clocked) return [];
    if (tick % 6 !== 0) return undefined;
    const sixteenths = tick / 6;
    if (sixteenths > 0x3fff) {
      report('the clock joined past the last song position MIDI can say: PAM continues from where it was');
      return [[0xfb]];
    }
    return [[0xf2, sixteenths & 0x7f, sixteenths >> 7], [0xfb]];
  }

  /**
   * The trigger behind `.pam()`: encodes one hap and sends it. Exported so that another output can
   * send to PAM as well as to something else. The haps of one scheduler tick are sent together, a moment later, in
   * the order of their onsets and with a variation or preset switch before the others of its onset.
   * PAM answers a switch by bringing back that variation's own mutes and knob values, so what the
   * pattern sets for the same bar has to be worked out after the switch.
   */
  function pamTrigger(hap, currentTime, cps, targetTime, options = {}) {
    tick.push([hap, currentTime, cps, targetTime, options]);
    if (tick.length === 1) Promise.resolve().then(flush);
  }

  function flush() {
    const due = tick;
    tick = [];
    const recalls = ([hap]) => (hap.value?.variation !== undefined || hap.value?.progNum !== undefined ? 0 : 1);
    due.sort((a, b) => a[3] - b[3] || recalls(a) - recalls(b));
    for (const fired of due) sendHap(...fired);
  }

  function sendHap(hap, currentTime, cps, targetTime, options) {
    const port = options.port ?? pamDefaults.port;
    const link = linkFor(port, options.encoder);
    const { events, problems } = compileValue(hap.value, setup);
    problems.forEach((p) => report(p));
    const latency = options.latency ?? pamDefaults.latency;
    const base = midiTime(targetTime, currentTime) + latency * 1000;
    // The hap's place on the pattern's own timeline. A followed pattern is queried ahead of it by the offset.
    const queried = hap.context?.pamAt ?? { offset: 0, version: 0 };
    const cycle = Number(hap.whole?.begin ?? 0) + queried.offset;
    const ticking = events.some(isClockTick);

    if (clock) {
      if (ticking) report('pamclock() is left out while following PAM: PAM is the clock');
      const nowMs = wallClock(env.performance.now());
      const followed = clock.follower.onHap({ cycle, unixMs: wallClock(base), version: queried.version, cps, nowMs });
      if (followed && followed.cps !== cps) setCps(followed.cps);
      // This hap was read from where PAM was before it moved. If it were sent, it would sound off PAM's beat.
      if (followed?.astray) {
        counters.astray++;
        return;
      }
    }
    if (!link.output) {
      counters.dropped++;
      return;
    }
    // The messages that go before a tick. `undefined` means no tick is sent: while PAM is the clock,
    // and until the clock can join.
    const start = !ticking ? [] : clock ? undefined : clockStart(link, hap, cycle);
    if (ticking && start) link.clocked = true;
    const sending = start ? events : events.filter((e) => !isClockTick(e));
    const duration = Number(hap.duration) / cps;
    const messages = [...(start ?? []).map((bytes) => ({ bytes, at: 0 })), ...link.encoder.encode(sending, duration)];
    for (const { bytes, at } of messages) {
      const when = Math.max(base + at * 1000, 0);
      if ((bytes[0] & 0xf0) === 0x90) link.channels.add(bytes[0] & 0x0f);
      // The last note-on or tick in the port's queue: a hush has to come after it.
      if ((bytes[0] & 0xf0) === 0x90 || bytes[0] === 0xf8) link.until = Math.max(link.until ?? 0, when);
      link.output.send(bytes, when);
      counters.sent++;
    }
  }

  // The REPL puts `setcps` in scope. A page without it has no tempo that this can set.
  function setCps(cps) {
    if (typeof env.setcps === 'function') env.setcps(cps);
    else report('this page has no setcps(): PAM is followed in position only, set its tempo by hand');
  }

  /**
   * Silences PAM: all notes off on every channel a note went to, and MIDI stop if a clock was running.
   * Runs when the REPL stops. Knob values are sent afresh afterwards, and mutes stay as PAM has them.
   * The scheduler sends ahead of time and Chrome's Web MIDI cannot take a queued message back, so
   * there the notes off go out twice, now and after the last queued note, and the stop after the last tick.
   * @name pamhush
   */
  function pamhush() {
    const now = env.performance.now();
    for (const link of links.values()) {
      if (!link.output) continue;
      const clears = typeof link.output.clear === 'function';
      if (clears) link.output.clear();
      const after = !clears && link.until > now ? link.until : undefined;
      for (const channel of link.channels) {
        link.output.send([0xb0 | channel, 123, 0]);
        if (after !== undefined) link.output.send([0xb0 | channel, 123, 0], after);
      }
      if (link.clocked) link.output.send([0xfc], after);
      link.clocked = false;
      link.until = undefined;
      link.encoder.forget();
    }
  }

  // A REPL says it stopped in one of two ways: the `strudel-stop` message, or, on strudel.cc, which
  // posts none, the scheduler's own log line as an event on `document`.
  if (typeof env.window?.addEventListener === 'function') {
    env.window.addEventListener('message', (e) => e.data === 'strudel-stop' && pamhush());
  }
  if (typeof env.document?.addEventListener === 'function') {
    env.document.addEventListener('strudel.log', (e) => e.detail?.message === '[cyclist] stop' && pamhush());
  }

  /**
   * Plays the pattern on a running PAM, over MIDI. PAM makes the sound, and Strudel's own output
   * stays silent for these haps. While PAM's clock is followed (`pamsetup({ follow: true })`) the pattern
   * is read from PAM's position: cycle 12 of the pattern plays in PAM's bar 12.
   *
   * What the haps may carry: `s` (a cell by name or number) and `note` / `n` / `freq` to play notes,
   * `cell` to say which cell, `velocity` and `gain`, `knob(...)` for any parameter, `variation`,
   * `press`, and plain `progNum`, `midicmd`, `ccn`/`ccv` and `nrpnn`/`nrpv` as `.midi()` reads them.
   *
   * @name pam
   * @memberof Pattern
   * @param {string | object} [options] a MIDI output name, or `{ port, latency }`
   * @returns Pattern
   * @example
   * s("1*4, ~ 2, 3*8").pam()
   * @example
   * note("c2 [eb2 g2]").cell(5).pam('IAC Driver Bus 1')
   */
  Pattern.prototype.pam = function (options) {
    const said = plain(options);
    const opts = said === undefined ? {} : typeof said === 'object' ? said : { port: String(said) };
    const pattern = this;
    const onPamsTimeline = new Pattern((state) => {
      const pamAt = clock?.follower.position();
      const read = pamAt?.offset ? pattern._early(pamAt.offset) : pattern;
      return read.query(state).map((hap) => hap.setContext({ ...hap.context, pam: opts, ...(pamAt && { pamAt }) }));
    });
    return onPamsTimeline.onTrigger((hap, currentTime, cps, targetTime) => pamTrigger(hap, currentTime, cps, targetTime, opts));
  };

  // Function form, so `all(pam)` sends every pattern to PAM.
  function pam(pat, options) {
    if (!isPattern(pat)) return (p) => p.pam(pat);
    return pat.pam(options);
  }

  /**
   * A MIDI clock for a standalone PAM that follows one (Settings > Mappings > External Clock Sync):
   * 24 ticks per beat, with a start at cycle 0 and a stop when the REPL stops. Added while the REPL
   * is already playing, it joins on the next sixteenth with a song position. A PAM inside a DAW
   * follows the DAW instead and ignores it: there, follow PAM (`pamsetup({ follow: true })`).
   *
   * @name pamclock
   * @param {number} [beats] beats per cycle (default 4: one cycle is one 4/4 bar)
   * @example
   * setcpm(128/4)
   * $: pamclock().pam()
   */
  function pamclock(beats = 4) {
    return midicmd('clock').segment(24 * Number(plain(beats) ?? 4));
  }

  /** Test seam: forget ports, counters, the setup and the clock. Not part of the API. */
  function reset() {
    links.clear();
    reported.clear();
    midiAccess = undefined;
    injected = undefined;
    setup = createSetup();
    setupOptions = {};
    held.mute = undefined;
    held.solo = undefined;
    counters = { sent: 0, dropped: 0, astray: 0 };
    tick = [];
    pamDefaults.port = undefined;
    pamDefaults.latency = 0;
    setFollow(false);
  }

  return { pam, pamsetup, pamstatus, pamhush, pamclock, pamTrigger, pamDefaults, reset };
}
