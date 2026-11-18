/*
output.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `.pam()`: sends a pattern to a running PAM, timed to each hap's onset. It is shaped like
// `.midi()`. There are two ways out: MIDI, to a PAM on this machine, and PAM's play interface, to
// a PAM in another tab of this browser (`pamsetup({ web })`). The encoding of both is in src/pam,
// as is the way the play interface's messages travel, and this file holds the outputs and the clock.
//
// Nothing here imports Strudel: `createOutput` is handed the core whose `Pattern` it extends, which
// is the npm package under Node and the page's own copy on strudel.cc.

import { compileValue } from '../pam/events.mjs';
import { createMidiEncoder } from '../pam/midi.mjs';
import { createSetup } from '../pam/midimap.mjs';
import { CLOCK_FEED_URL, createFollower, readSnapshot } from '../pam/follow.mjs';
import { checkSetup, createPlayClient, playTarget, toPlayEvents } from '../pam/play.mjs';

const isClockTick = (event) => event.type === 'transport' && event.command === 'clock';
// How long `pamsetup({ follow })` waits for PAM's first clock snapshot before it gives up waiting.
const FIRST_SNAPSHOT_MS = 3000;
// A PAM in the browser needs about 400 ms to prepare a variation before it can switch to it on a
// bar line, and Strudel's scheduler hands a hap over 100 to 350 ms before its time. So switches
// are read out of the patterns this much further ahead than the scheduler reads, and sent then.
const SWITCH_AHEAD_MS = 1200;
// What the scheduler's own look-ahead can come to, and the room kept under PAM's look-ahead limit.
const SCHEDULER_AHEAD_MS = 400;
const AHEAD_ROOM_MS = 100;
// How many cycles of a pattern are looked at, when `.pam()` is called, for a variation.
const PROBED_CYCLES = 8;
// A switch that was sent ahead is remembered for this many seconds past its time: a slower tempo
// puts off the moment when the scheduler hands its hap over, and it must not go again then.
const SWITCH_KEPT_S = 30;
// A switch this far from where the pattern has it is no longer on its bar line for PAM, in seconds.
const OFF_THE_LINE_S = 0.03;
// Two haps whose times are this near are of one moment, in seconds: their times come by different sums.
const ONE_MOMENT_S = 1e-6;
// Every time that goes to PAM is read from the audio context of the page that runs Strudel, and
// Strudel's makes no sound of its own when every pattern goes to `.pam()`. Chrome takes an audio
// context that has given out nothing but zeros for thirty seconds off the audio device and runs
// it from a timer, and its clock then steps and wanders, or worse. So a page that sends to PAM
// keeps a constant this small in that context: a millionth of full scale, 120 dB down. It is not
// heard, and it is not zero.
const KEPT_ON_DEVICE = 1e-6;
// What a hap that is read ahead sends: its switch, and what can ride a switch.
const SENT_AHEAD = new Set(['variation', 'knob', 'switch']);
// The refusals that pass. PAM's transport is started again after one of them.
const PASSING = new Set(['too_late', 'too_far_ahead', 'audio-blocked', 'rate_limited']);

/**
 * Makes the output for one copy of Strudel's core.
 *
 * @param {{ Pattern: Function, isPattern: Function, logger: Function, midicmd: Function, getClockTime?: Function }} core
 *   `getClockTime` is the scheduler's clock, which Strudel has had since its schedulers call
 *   `onSchedule`. It is looked up when it is needed
 * @param {object} [env] where `navigator`, `performance`, `window`, `EventSource`,
 *   `getAudioContext` and the REPL's `setcps` are looked up, each time they are needed (default `globalThis`)
 * @param {string} [home] the address the page module was imported from. `pamsetup({ web: true })`
 *   plays the PAM of that site
 */
export function createOutput(core, env = globalThis, home = undefined) {
  const { Pattern, isPattern, logger, midicmd } = core;
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
  let web; // { page, origin, preset? } while the setup chose the web output, { failed } when it could not
  let play; // the connection to PAM's play interface
  let batch = []; // the play events of this scheduler tick
  let batchHaps = 0; // and how many haps they came from
  let transport; // { bpm, shiftMs } while pamclock() has PAM's transport running through the web output
  let kept; // { context, source }: the constant that keeps the page's audio context on the audio device
  const levels = new Map(); // 'mute 3' -> true: the mutes and solos that the patterns last asked of a PAM in the browser
  let switching = false; // whether a pattern on this page has asked for a variation: nothing is read ahead until one has
  const sentAhead = new Map(); // '<cycle> <variation>' -> the switches that PAM has been sent ahead of their time
  let upcoming = []; // the mutes and solos that were read ahead and are still to come: { targetTime, held, on, born }
  let generation = 0; // counts the setups, which is how the code of one evaluation is told from the code before it
  let played = 0; // the generation of the newest code that has had a tick

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
   * @param {boolean | string | { room?: string, site?: string }} [options.web] play a PAM that runs
   *   in a browser tab, with no MIDI: `true` for the PAM of the site that this module was imported
   *   from, PAM's address (in single quotes), or `{ room: 'code' }` to pair with the PAM page that
   *   gave that code (`site` beside it names a PAM elsewhere). Without a code the first call opens
   *   PAM's tab, so it has to come from a key press or a click
   * @param {string} [options.preset] with `web`: the preset that PAM should hold, by its name in PAM's list
   * @param {{ send: (bytes: number[], timestamp?: number) => void }} [options.output] a MIDI output
   *   to use as it is (outside the browser, where there is no Web MIDI)
   * @returns {Promise<object>} what `pamstatus()` returns, once the port is open and, when
   *   following, PAM's clock has been heard. With `web`: once the person at the PAM tab has
   *   chosen Allow or Deny
   * @example
   * await pamsetup({ port: 'IAC Driver Bus 1', channels: 'cell', poly: [5, 8], names: { bd: 1, sd: 2, hh: 3 } })
   * @example
   * await pamsetup({ web: true, names: { bd: 1, sd: 2, hh: 3 } })
   */
  function pamsetup(options = {}) {
    keepOnDevice();
    const { output, ...said } = options;
    const { port, latency, muted, soloed, follow, web: toWeb, preset, ...rest } = plain(said);
    setup = createSetup(rest);
    setupOptions = rest;
    generation++;
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
    setWeb(toWeb, preset);
    if (web) {
      if (follow) report('follow is not in the web output: PAM in the browser does not send its clock to the page that plays it. Leave follow out, and pamclock() runs PAM from here', 'error');
      setFollow(false);
      if (web.failed) return Promise.resolve(pamstatus());
      if (!play.connected) transport = undefined;
      return play.connect(web).then(() => {
        checkWelcome();
        return pamstatus();
      });
    }
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
   * With the web output, `web` holds the connection: its state, how PAM is reached (`via`: its own
   * `tab`, the `opener` or `parent` page, or a data `channel` with its `room` code and the `link` to
   * PAM's page), what PAM said it has (`welcome`), the lead PAM needs, the least look-ahead the
   * scheduler has given and how far everything was moved to make up for it (`leadMs`, `aheadMs`,
   * `shiftMs`), how far PAM's clock is from this page's (`clockMs`), and what PAM accepted and
   * refused, by code.
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
      ...(web ? { web: web.failed ? { state: 'unavailable' } : play.status() } : {}),
    };
  }

  // Chooses the output. Each setup is the whole description, so one that does not say `web` is MIDI.
  function setWeb(toWeb, preset) {
    const was = web;
    web = undefined;
    if (toWeb === undefined || toWeb === null || toWeb === false) {
      if (was) play?.bye();
      if (was) transport = undefined;
      if (was) levels.clear();
      if (was) forgetAhead();
      if (preset !== undefined) report('preset is read by the web output only: without web, load the preset in PAM yourself');
      return;
    }
    try {
      web = { ...playTarget(toWeb, home), ...(preset === undefined ? {} : { preset: String(preset) }) };
      play ??= createPlayClient({ env, report, log: (text) => logger(text), onCells: checkWelcome, onRefused });
    } catch (err) {
      web = { failed: true };
      report(err.message, 'error');
    }
  }

  // PAM did not take a start of its transport, for a reason that passes: the next clock tick starts it again.
  function onRefused(event, code) {
    if (event?.type === 'transport' && event.action !== 'stop' && PASSING.has(code)) transport = undefined;
  }

  // The setup describes a PAM for MIDI. PAM in the browser says what it has, so the two are compared.
  function checkWelcome() {
    if (web && play?.welcome) checkSetup(play.welcome, setup, setupOptions).forEach((text) => report(text));
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

  // Puts the constant into the page's audio context, once for each context. A page with no audio
  // context of Strudel's in reach has none to keep, and its times are read without one.
  function keepOnDevice() {
    try {
      const context = env.getAudioContext?.();
      if (!context || kept?.context === context) return;
      const source = context.createConstantSource();
      source.offset.value = KEPT_ON_DEVICE;
      source.connect(context.destination);
      source.start();
      kept = { context, source };
    } catch {
      // This context makes no constant.
    }
  }

  // One reading of the clocks, as a function from audio-clock seconds to the performance.now()
  // milliseconds that Web MIDI timestamps are in. Where an audio context is in reach (the REPL's
  // `getAudioContext`), the context pairs the two clocks itself, which avoids the render-quantum
  // jitter of reading `currentTime`. Elsewhere `currentTime` counts as now.
  function readClocks(currentTime) {
    let stamp;
    try {
      stamp = env.getAudioContext?.()?.getOutputTimestamp?.();
    } catch {
      stamp = undefined;
    }
    if (stamp?.performanceTime != null && stamp?.contextTime != null) {
      return (targetTime) => stamp.performanceTime + (targetTime - stamp.contextTime) * 1000;
    }
    const now = env.performance.now();
    return (targetTime) => now + (targetTime - currentTime) * 1000;
  }

  const midiTime = (targetTime, currentTime) => readClocks(currentTime)(targetTime);

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
    // A hap that was read ahead comes as one that starts in the tick and ends where the hap itself starts.
    const time = hap.context?.pamAhead ? targetTime + Number(hap.duration) / cps : targetTime;
    tick.push([hap, currentTime, cps, time, options]);
    if (tick.length === 1) Promise.resolve().then(flush);
  }

  // The scheduler's clock now, for a scheduler that hands over only the hap, its time and the tempo.
  function schedulerNow(targetTime) {
    for (const read of [() => core.getClockTime(), () => env.getAudioContext().currentTime]) {
      try {
        const now = read();
        if (Number.isFinite(now)) return now;
      } catch {
        // That clock is not here.
      }
    }
    return targetTime;
  }

  function flush() {
    keepOnDevice();
    const due = web ? withSwitchesAhead(tick) : tick;
    tick = [];
    if (!due.length) return;
    const recalls = ([hap]) => (hap.value?.variation !== undefined || hap.value?.progNum !== undefined ? 0 : 1);
    due.sort((a, b) => a[3] - b[3] || recalls(a) - recalls(b));
    // For PAM in the browser the whole tick is timed against one reading of the clocks. Two haps
    // of one moment then carry the very same time, which is what makes a mute ride a switch.
    const timeOf = web ? readClocks(due[0][1]) : undefined;
    for (const fired of due) sendHap(...fired, timeOf);
    if (!batch.length) return;
    // The tick's events go to PAM as one message: PAM places them all against one reading of its clock.
    const events = batch;
    const haps = batchHaps;
    batch = [];
    batchHaps = 0;
    if (!play?.send(events)) {
      counters.dropped += haps;
      return;
    }
    counters.sent += events.length;
    // PAM's bar lines are where this message put them, which is by the shift that it went with.
    if (transport && events.some((event) => event.action === 'seek')) transport.shiftMs = play.shiftMs;
  }

  // The web output's half of `sendHap`. A hap's time goes onto the clock that the two tabs share,
  // and its values go as they are: a knob keeps its exact value, and a mute or a solo is a level.
  function sendToWeb(hap, cps, targetTime, options, timeOf) {
    const { events, problems } = compileValue(hap.value, setup);
    problems.forEach((p) => report(p));
    if (!play?.connected) {
      counters.dropped++;
      return;
    }
    const latency = options.latency ?? pamDefaults.latency;
    const time = wallClock(timeOf(targetTime) + latency * 1000);
    const duration = (Number(hap.duration) / cps) * 1000;
    const ahead = Boolean(hap.context?.pamAhead);
    if (events.some((e) => e.type === 'variation')) switching = true;
    // A hap that was read ahead sends its switch and what rides a switch, and nothing that sounds.
    // When the scheduler delivers it at its own time, the switch has gone and the rest goes.
    const wanted = ahead ? events.filter((e) => SENT_AHEAD.has(e.type)) : events.filter((e) => !isClockTick(e) && !(e.type === 'variation' && wentAhead(hap, e.index, targetTime)));
    const mapped = toPlayEvents(wanted, { time, duration, cells: play.welcome.cells });
    if (!ahead) mapped.unsupported.forEach((text) => report(text));
    const sending = [...(!ahead && events.some(isClockTick) ? clockEvents(hap, cps, time) : []), ...mapped.events];
    if (!sending.length) return;
    for (const event of sending) {
      batch.push(event);
      if (event.type === 'variation') batch.push(...heldLevels(event.time, targetTime));
      if (ahead || (event.type !== 'mute' && event.type !== 'solo')) continue;
      takeUpcoming(targetTime + ONE_MOMENT_S);
      levels.set(`${event.type} ${event.cell}`, event.on);
    }
    batchHaps++;
  }

  // A variation switch puts PAM's mutes and solos back to what the variation stores. So each level
  // that a pattern asked for goes again with the switch: behind it, in the same message and with
  // its very time, which is how PAM lets an event ride a switch and hold once the switch has
  // landed. A level that a pattern sets for that same time comes later still, and the later wins.
  // For a switch that is sent ahead, the levels are what they will be when it lands.
  function heldLevels(time, targetTime) {
    return [...levelsAt(targetTime)].map(([held, on]) => {
      const [type, cell] = held.split(' ');
      return { type, time, cell: Number(cell), on };
    });
  }

  // What was read ahead becomes the level once its moment has come, whether the scheduler handed
  // its hap over or not: a scheduler skips a tick that it comes to too late, and a switch that
  // went ahead has carried the level to PAM already. `upcoming` is in the order of its moments.
  function takeUpcoming(upTo) {
    for (const coming of upcoming) if (coming.targetTime <= upTo) levels.set(coming.held, coming.on);
    upcoming = upcoming.filter((coming) => coming.targetTime > upTo);
  }

  // The mutes and solos as they stand just before a moment: those whose moment has come, and
  // over them those that were read ahead and come before it.
  function levelsAt(targetTime) {
    const then = new Map(levels);
    for (const coming of upcoming) if (coming.targetTime < targetTime - ONE_MOMENT_S) then.set(coming.held, coming.on);
    return then;
  }

  // The mutes and solos that a hap sets: [['mute 3', true]].
  function levelsOf(hap) {
    if (!Object.keys(hap.value ?? {}).some((name) => /_(mute|solo)$/.test(name))) return [];
    return compileValue(hap.value, setup)
      .events.filter((event) => event.type === 'switch')
      .map((event) => [`${event.what} ${event.cell}`, event.on]);
  }

  // The variation that a hap switches to, counted from 1, when it switches.
  const switchOf = (hap) => (hap.value?.variation === undefined ? undefined : compileValue(hap.value, setup).events.find((e) => e.type === 'variation')?.index);
  // Where a hap starts in the pattern. One that was read ahead is carried by a hap that ends there.
  const onsetOf = (hap) => Number(hap.context?.pamAhead ? hap.whole.end : hap.whole.begin);
  const switchKey = (hap, index) => `${onsetOf(hap)} ${index}`;

  // Whether the switch of a hap that the scheduler now delivers has gone ahead of it. A switch
  // goes to PAM once: PAM prepares a second one for the same bar line again and lands it a bar
  // late (measured on PAM's side, 2026-11-18). So it is not sent again after a change of tempo
  // either, where the one that went has the old tempo's time, and that is said.
  function wentAhead(hap, index, targetTime) {
    const sent = sentAhead.get(switchKey(hap, index));
    if (!sent) return false;
    const off = sent.targetTime - targetTime;
    if (Math.abs(off) > OFF_THE_LINE_S) {
      report(
        `the tempo changed after PAM was sent the switch to variation ${index}, and a switch cannot be sent twice: PAM would switch twice. It keeps the time that the old tempo gave it, ${Math.round(Math.abs(off) * 1000)} ms ${off > 0 ? 'later' : 'earlier'} than the pattern has it now`,
      );
    }
    sent.delivered = true;
    return true;
  }

  // How far ahead of the scheduler the patterns are read for switches, in seconds. Nothing is
  // read ahead before a pattern has asked for a variation, or where there is no PAM to send to.
  function switchReach() {
    if (!switching || !play?.connected) return 0;
    const taken = SCHEDULER_AHEAD_MS + Math.max(0, pamDefaults.latency * 1000);
    return Math.max(0, Math.min(SWITCH_AHEAD_MS, switchRoom() - taken)) / 1000;
  }

  // How far ahead of its time a switch can reach PAM, in milliseconds: PAM's look-ahead, less the shift and some room.
  const switchRoom = () => (Number(play.welcome?.limits?.lookaheadMs) || 2000) - play.shiftMs - AHEAD_ROOM_MS;

  // The haps of a `.pam()` pattern that lie ahead of what the scheduler asked for and have not
  // been read ahead yet. `ahead` is how far this pattern has been read. A scheduler hands over
  // only what starts inside its tick: Strudel's did hand over whatever a query gave it, and since
  // its schedulers call `onSchedule` they drop what starts later. So each hap goes as a hap that
  // starts with the tick and ends where the hap itself starts. Whatever is done to the pattern
  // after `.pam()` is done to both ends, and the hap's own time is the carrier's time and length.
  function readAhead(read, state, ahead) {
    const cps = Number(state.controls._cps);
    const reach = cps > 0 ? switchReach() * cps : 0;
    if (!(reach > 0)) {
      ahead.until = undefined;
      return [];
    }
    const begin = Number(state.span.begin);
    const end = Number(state.span.end);
    // The scheduler started over or jumped: it is read ahead afresh from where it is now.
    if (ahead.until === undefined || begin < ahead.begin || end > ahead.until) ahead.until = end;
    ahead.begin = begin;
    const from = ahead.until;
    const to = end + reach;
    if (!(to > from)) return [];
    ahead.until = to;
    // The span's own fractions decide where it starts, as they do for the scheduler's spans.
    const span = new state.span.constructor(from, to);
    // A hap that sets the tempo is left to its own time: the scheduler would take it at once.
    return read
      .query(state.setSpan(span))
      .filter((hap) => hap.hasOnset() && hap.whole.begin >= span.begin && hap.value?.cps === undefined)
      .map((hap) => hap.withSpan(() => new state.span.constructor(state.span.begin, hap.whole.begin)));
  }

  // A tick as it goes to PAM in the browser: the haps the scheduler delivered at their own time,
  // and of those read ahead only each switch that PAM has not been sent yet, with what the
  // patterns set for the very moment of that switch, which rides it.
  function withSwitchesAhead(due) {
    const early = due.filter(([hap]) => hap.context?.pamAhead);
    if (!due.length || (!early.length && !sentAhead.size && !upcoming.length)) return due;
    const usual = early.length ? due.filter(([hap]) => !hap.context?.pamAhead) : due;
    const now = due[0][1]; // the scheduler's clock at this tick
    const changed = newCodePlays(due);
    takeUpcoming(now);
    for (const [key, sent] of sentAhead) if (sent.targetTime < now - SWITCH_KEPT_S) sentAhead.delete(key);
    if (!play?.connected) return usual;
    // A pattern that is slowed after `.pam()` is read further ahead than the scheduler's time:
    // what lies beyond PAM's look-ahead waits for the scheduler.
    const room = switchRoom();
    const asked = new Set();
    const fresh = [];
    for (const fired of due) {
      const [hap, , , targetTime, options] = fired;
      const index = switchOf(hap);
      if (index === undefined) continue;
      const key = switchKey(hap, index);
      asked.add(key);
      const sent = sentAhead.get(key);
      if (sent && !hap.context?.pamAhead) sayWhatChanged(sent, usual, targetTime);
      if (sent || !hap.context?.pamAhead) continue;
      if ((targetTime - now + (options.latency ?? pamDefaults.latency)) * 1000 > room) continue;
      sentAhead.set(key, { cycle: onsetOf(hap), index, targetTime, born: hap.context.pamBorn });
      fresh.push(fired);
    }
    // What is of a new switch's moment rides it, and PAM asks for the very time of the switch.
    const riders = [];
    for (const fired of early) {
      const moment = fresh.find((switching) => Math.abs(switching[3] - fired[3]) < ONE_MOMENT_S)?.[3];
      if (moment === undefined) continue;
      fired[3] = moment;
      if (switchOf(fired[0]) === undefined) riders.push(fired);
    }
    for (const [hap, , , targetTime] of early) {
      for (const [held, on] of levelsOf(hap)) upcoming.push({ targetTime, held, on, born: hap.context.pamBorn });
    }
    upcoming.sort((a, b) => a.targetTime - b.targetTime);
    // What each new switch carries: the levels as they will be, and over them what is set at its moment.
    for (const [hap, , , targetTime] of fresh) {
      const carried = levelsAt(targetTime);
      for (const [other, , , at] of early) if (at === targetTime) for (const [held, on] of levelsOf(other)) carried.set(held, on);
      sentAhead.get(switchKey(hap, switchOf(hap))).carried = carried;
    }
    if (changed) sayWhatStays(asked, now);
    return [...usual, ...fresh, ...riders];
  }

  // Whether this is the first tick of code that is newer than any that has played. The mutes and
  // solos that the code before it had coming are not coming any more.
  function newCodePlays(due) {
    const newest = Math.max(played, ...due.map(([hap]) => hap.context?.pamBorn ?? 0));
    if (newest === played) return false;
    played = newest;
    upcoming = upcoming.filter((coming) => coming.born >= newest);
    return true;
  }

  // The scheduler delivers the hap of a switch that went ahead. Where the mutes and solos are not
  // what the switch carried, the code has changed since, and the switch cannot go again. What the
  // code sets now is sent at its own time, where PAM does not promise that it outlasts the switch.
  function sayWhatChanged(sent, usual, targetTime) {
    const wanted = levelsAt(targetTime);
    const upTo = usual.filter((fired) => fired[3] <= targetTime + ONE_MOMENT_S).sort((a, b) => a[3] - b[3]);
    for (const [hap] of upTo) for (const [held, on] of levelsOf(hap)) wanted.set(held, on);
    const changed = [...new Set([...wanted.keys(), ...sent.carried.keys()])].filter((held) => wanted.get(held) !== sent.carried.get(held));
    if (!changed.length) return;
    report(
      `PAM was sent the switch to variation ${sent.index} before the code had ${changed.map((held) => `the ${held.replace(' ', ' of cell ')}`).join(', ')} as it is now, and a switch cannot be sent twice: PAM would switch twice. What the code sets is sent at its own time, and may not hold until the next switch`,
    );
  }

  // PAM cannot take back a switch that it has been sent. When the code changes, a switch that the
  // code before it sent ahead still lands, and that is said once, on the new code's first tick.
  function sayWhatStays(asked, now) {
    for (const [key, sent] of sentAhead) {
      if (sent.born >= played || sent.delivered || asked.has(key) || sent.targetTime <= now) continue;
      const other = [...sentAhead.values()].find((later) => later.born >= played && later.cycle === sent.cycle);
      report(
        `PAM has a switch to variation ${sent.index} that is due in ${Math.round((sent.targetTime - now) * 1000)} ms, sent before the code changed. PAM cannot be asked to drop one switch, so it lands` +
          (other ? `. The code now asks for variation ${other.index} at that moment, and that was sent after it: PAM takes it where it still has the time to prepare it` : ', though the code no longer asks for it'),
      );
      sentAhead.delete(key);
    }
  }

  function forgetAhead() {
    sentAhead.clear();
    upcoming = [];
  }

  // pamclock() through the web output. PAM's transport is started where the pattern is and at the
  // pattern's tempo, and is told again only when the tempo changes: no tick is sent. PAM's bar
  // lines are then where the shift put them. When the shift changes, every other event moves, so
  // the transport is put where the pattern is again, or PAM's own patterns and its bar lines
  // would be that far from the notes.
  function clockEvents(hap, cps, time) {
    const beats = 1 / (24 * Number(hap.duration));
    const bpm = Math.round(cps * 60 * beats * 1e6) / 1e6;
    if (!transport || transport.shiftMs !== play.shiftMs) {
      transport = { bpm, shiftMs: play.shiftMs };
      const ppqPosition = Number(hap.whole?.begin ?? 0) * beats;
      return [
        { type: 'transport', time, action: 'seek', ppqPosition },
        { type: 'transport', time, action: 'play', bpm },
      ];
    }
    if (transport.bpm === bpm) return [];
    transport.bpm = bpm;
    return [{ type: 'transport', time, action: 'play', bpm }];
  }

  function sendHap(hap, currentTime, cps, targetTime, options, timeOf) {
    if (web) return sendToWeb(hap, cps, targetTime, options, timeOf);
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
   * A PAM in the browser is asked to flush instead: it releases its notes and drops the knob moves and
   * switches that were waiting, and its transport is stopped if `pamclock()` had started it. Notes that
   * the scheduler had already sent ahead, a tenth to a third of a second of them, still play.
   * @name pamhush
   */
  function pamhush() {
    if (web) {
      play?.flush();
      if (transport) play?.send([{ type: 'transport', action: 'stop' }]);
      transport = undefined;
      batch = [];
      batchHaps = 0;
      forgetAhead();
    }
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
   * Plays the pattern on a running PAM: over MIDI, or in a browser tab after `pamsetup({ web: true })`.
   * PAM makes the sound, and Strudel's own output stays silent for these haps. While PAM's clock is
   * followed (`pamsetup({ follow: true })`) the pattern is read from PAM's position: cycle 12 of the
   * pattern plays in PAM's bar 12.
   *
   * What the haps may carry: `s` (a cell by name or number) and `note` / `n` / `freq` to play notes,
   * `cell` to say which cell, `velocity` and `gain`, `knob(...)` for any parameter, `variation`,
   * `press`, and plain `progNum`, `midicmd`, `ccn`/`ccv` and `nrpnn`/`nrpv` as `.midi()` reads them.
   * The web output has no `press`, `progNum`, `ccn` or `nrpnn`, and says so once.
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
    const born = generation;
    if (web && !switching) switching = asksForVariation(pattern);
    const ahead = {};
    const onPamsTimeline = new Pattern((state) => {
      const pamAt = clock?.follower.position();
      const read = pamAt?.offset ? pattern._early(pamAt.offset) : pattern;
      const mark = (more) => (hap) => hap.setContext({ ...hap.context, pam: opts, ...(pamAt && { pamAt }), ...more });
      const haps = read.query(state).map(mark(web && { pamBorn: born }));
      // Only the scheduler's queries are read ahead of: the editor reads the patterns too, to draw them.
      if (!web || !switching || !state.controls?.cyclist) return haps;
      return [...haps, ...readAhead(read, state, ahead).map(mark({ pamBorn: born, pamAhead: true }))];
    });
    // Strudel's schedulers call `onSchedule(hap, time, cps)` where it exists, and say that `onTrigger` is on its way out.
    if (typeof onPamsTimeline.onSchedule === 'function') {
      return onPamsTimeline.onSchedule((hap, targetTime, cps) => pamTrigger(hap, schedulerNow(targetTime), cps, targetTime, opts));
    }
    return onPamsTimeline.onTrigger((hap, currentTime, cps, targetTime) => pamTrigger(hap, currentTime, cps, targetTime, opts));
  };

  // Whether a pattern asks for a variation in its first cycles. One that starts later is found when
  // the scheduler first delivers it, and that first switch goes with only the scheduler's notice.
  function asksForVariation(pattern) {
    try {
      return pattern.queryArc(0, PROBED_CYCLES).some((hap) => hap.value?.variation !== undefined);
    } catch {
      return false;
    }
  }

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
    play?.bye();
    play = undefined;
    web = undefined;
    batch = [];
    batchHaps = 0;
    transport = undefined;
    kept?.source.disconnect();
    kept = undefined;
    levels.clear();
    forgetAhead();
    switching = false;
    generation = 0;
    played = 0;
  }

  return { pam, pamsetup, pamstatus, pamhush, pamclock, pamTrigger, pamDefaults, reset };
}
