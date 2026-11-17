/*
receiver.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// TidalCycles -> PAM. Tidal sends each event to the `pamTarget` of mapaudio.tidal as one OSC
// message of named arguments, in a bundle stamped with the event's time. This module turns those
// into the flat value map that src/pam reads, encodes it with the same encoder that `.pam()` uses, and hands
// each MIDI message to `send` with the time it is due. It holds no socket and no MIDI port.

import { compileValue } from '../pam/events.mjs';
import { createMidiEncoder } from '../pam/midi.mjs';
import { createSetup } from '../pam/midimap.mjs';
import { isCellParamName, resolveParam } from '../pam/params.mjs';
import { decodePacket } from './osc.mjs';

/** The address every PAM event is sent to. */
export const TIDAL_ADDRESS = '/pam';
/** The argument every PAM event carries, so that Tidal sends PAM nothing meant for SuperDirt. */
export const TIDAL_MARK = 'pamto';
/** What a knob's argument name starts with: `pam_filterCutoff`, `pam_macro_filterCutoff`. */
export const KNOB_PREFIX = 'pam_';
/** Tidal's `note "c5"` is 0, and middle C is MIDI note 60. */
export const TIDAL_NOTE_ZERO = 60;

const SWITCHES = new Set(['mute', 'solo']);
const TRANSPORT = new Set(['midiClock', 'start', 'stop', 'continue']);
const isClockTick = (event) => event.type === 'transport' && event.command === 'clock';
// A clock whose ticks stopped coming this long ago has been hushed: PAM is told to stop.
const CLOCK_SILENCE_MS = 500;

// The key that src/pam reads a knob under: a per-cell name waits for the event's cell, and a full id stays as it is.
function knobKey(name) {
  const open = /^cell_(.+)$/.exec(name);
  const bare = open ? open[1] : name;
  if (SWITCHES.has(bare) || isCellParamName(bare)) return `cell_${bare}`;
  if (/^cell\d+_(mute|solo)$/.test(name) || resolveParam(name)) return name;
  return undefined;
}

/**
 * Reads one message's named arguments as Tidal sends them.
 *
 * @param {unknown[]} args name, value, name, value, ...
 * @returns {{ value: Record<string, unknown>, seconds: number, cycle: number, cps: number, steps: number,
 *   setup?: string, problems: string[] }} `value` is the map `compileValue` reads; `seconds` is how
 *   long a note is held; `steps` is the event's length in cycles
 */
export function tidalValue(args) {
  const named = {};
  for (let i = 0; i + 1 < args.length; i += 2) named[String(args[i])] = args[i + 1];
  const value = {};
  const problems = [];
  const number = (key) => (typeof named[key] === 'number' && Number.isFinite(named[key]) ? named[key] : undefined);

  if (named.pam !== undefined) value.s = named.pam;
  if (named.cell !== undefined) value.cell = named.cell;
  if (number('note') !== undefined) value.note = named.note + TIDAL_NOTE_ZERO;
  else if (number('up') !== undefined) value.note = named.up + TIDAL_NOTE_ZERO;
  if (number('midinote') !== undefined) value.note = named.midinote;
  if (number('freq') !== undefined) value.freq = named.freq;
  if (number('n') !== undefined) value.n = named.n;
  for (const key of ['velocity', 'gain', 'variation', 'press', 'progNum']) {
    if (named[key] !== undefined) value[key] = named[key];
  }
  // SuperDirt's MIDI vocabulary, in Tidal's units: channels from 0, controller values 0-127.
  if (TRANSPORT.has(named.midicmd)) value.midicmd = named.midicmd;
  if (number('midichan') !== undefined) value.midichan = named.midichan + 1;
  if (number('ccn') !== undefined && number('ccv') !== undefined) {
    value.ccn = named.ccn;
    value.ccv = named.ccv / 127;
  }
  if (number('nrpnn') !== undefined && number('nrpnv') !== undefined) {
    value.nrpnn = named.nrpnn;
    value.nrpv = named.nrpnv / 16383;
  }
  for (const [key, raw] of Object.entries(named)) {
    if (!key.startsWith(KNOB_PREFIX)) continue;
    const name = key.slice(KNOB_PREFIX.length);
    const as = knobKey(name);
    if (as) value[as] = raw;
    else problems.push(`knob "${name}": PAM has no parameter of that name`);
  }

  const cps = number('cps') ?? 0;
  const delta = number('delta') ?? 0;
  const seconds = number('sustain') ?? delta * (number('legato') ?? 1);
  return {
    value,
    seconds: Math.max(seconds, 0),
    cycle: number('cycle') ?? 0,
    cps,
    steps: delta * cps,
    ...(typeof named.pamsetup === 'string' ? { setup: named.pamsetup } : {}),
    problems,
  };
}

const list = (text) => (text.trim() === '' ? [] : text.split(',').map((item) => item.trim()));
const numbers = (text, what) =>
  list(text).map((item) => {
    const n = Number(item);
    if (!Number.isFinite(n)) throw new Error(`${what}: "${item}" is not a number`);
    return n;
  });
// `5:36,7:60` as { 5: 36, 7: 60 }; one number alone, or a plain list, as it is.
function perCell(text, what) {
  if (!text.includes(':')) {
    const all = numbers(text, what);
    return all.length === 1 ? all[0] : all;
  }
  return Object.fromEntries(
    list(text).map((pair) => {
      const [cell, n] = pair.split(':').map(Number);
      if (!Number.isFinite(cell) || !Number.isFinite(n)) throw new Error(`${what}: "${pair}" is not cell:number`);
      return [cell, n];
    }),
  );
}

/**
 * Reads what `pamsetup "..."` says: `key=value` pairs, the keys and meanings of Strudel's
 * `pamsetup({...})`, or the same object as JSON.
 *
 *   channels=cell poly=5,7,8 roots=5:36,7:60 names=bd:1,cp:2 port=IAC Driver Bus 1 latency=0.02
 *
 * @param {string} text
 * @returns {object} `createSetup`'s options, plus `port`, `latency`, `muted` and `soloed`
 */
export function parseSetup(text) {
  const source = String(text).trim();
  if (source.startsWith('{')) return JSON.parse(source);
  const out = {};
  const keys = [...source.matchAll(/(?:^|\s)([A-Za-z]+)=/g)];
  if (source !== '' && (!keys.length || keys[0].index !== 0)) throw new Error(`setup: "${source}" is not key=value pairs`);
  keys.forEach((match, i) => {
    const key = match[1];
    const raw = source.slice(match.index + match[0].length, keys[i + 1]?.index ?? source.length).trim();
    switch (key) {
      case 'channels':
        out.channels = raw === 'cell' ? 'cell' : perCell(raw, key);
        break;
      case 'notes':
      case 'roots':
        out[key] = perCell(raw, key);
        break;
      case 'poly':
      case 'muted':
      case 'soloed':
        out[key] = numbers(raw, key);
        break;
      case 'names':
        out.names = Object.fromEntries(
          list(raw).map((pair) => {
            const [name, cell] = pair.split(':');
            return [name, Number(cell)];
          }),
        );
        break;
      case 'cc':
        out.cc = raw === 'automap' ? 'automap' : Object.fromEntries(list(raw).map((pair) => [pair.split(':')[0], Number(pair.split(':')[1])]));
        break;
      case 'control':
      case 'latency':
        out[key] = numbers(raw, key)[0];
        break;
      case 'port':
        out.port = raw;
        break;
      default:
        throw new Error(`setup: "${key}" is not one of channels, notes, roots, poly, names, control, cc, port, latency, muted, soloed`);
    }
  });
  return out;
}

/**
 * Makes the receiver for one PAM.
 *
 * @param {object} options
 * @param {(bytes: number[], whenMs: number) => void} options.send takes each MIDI message with the
 *   Unix time in milliseconds it is due. The caller owns the MIDI port and its clock
 * @param {object | string} [options.setup] the PAM being played, as `pamsetup` would describe it.
 *   A `pamsetup` event from Tidal replaces it
 * @param {(message: string) => void} [options.log] told each problem once
 * @param {(setup: { port?: string }) => void} [options.onSetup] told when the setup changes
 * @param {object} [options.encoder] options for the MIDI encoder (`variationLead`, `noteOffGap`)
 */
export function createTidalReceiver({ send, setup: initial, log = () => {}, onSetup = () => {}, encoder: encoderOptions } = {}) {
  if (typeof send !== 'function') throw new Error('[pam] the Tidal receiver needs somewhere to send MIDI: createTidalReceiver({ send })');
  let options = {};
  let setup = createSetup();
  const encoder = createMidiEncoder(setup, encoderOptions);
  let latencyMs = 0;
  let port;
  let clocked = false;
  let lastTick; // when the last clock tick sent is due
  const channels = new Set();
  const reported = new Set();
  const counters = { messages: 0, sent: 0, ignored: 0 };
  let pending = [];

  function report(message) {
    if (reported.has(message)) return;
    reported.add(message);
    log(`[pam] ${message}`);
  }

  function use(said) {
    let next;
    try {
      next = typeof said === 'string' ? parseSetup(said) : { ...said };
      const { port: toPort, latency, muted, soloed, ...rest } = next;
      const made = createSetup(rest);
      setup = made;
      options = next;
      encoder.use(setup);
      latencyMs = (Number(latency) || 0) * 1000;
      port = toPort === undefined || toPort === '' ? undefined : String(toPort);
      for (const [what, cells] of [['mute', muted], ['solo', soloed]]) {
        if (!cells) continue;
        for (let cell = 1; cell <= setup.cells.length; cell++) encoder.assume(what, cell, cells.includes(cell));
      }
      reported.clear();
      onSetup({ port });
    } catch (err) {
      report(String(err.message).replace(/^\[pam\] /, ''));
    }
  }
  if (initial !== undefined) use(initial);

  // What starts PAM's transport with a clock tick, as `.pam()` does it: Start at the top of cycle 0,
  // else a song position and Continue, which a clock can only join on a sixteenth.
  function clockStart(cycle, steps) {
    const tick = steps > 0 ? Math.round(cycle / steps) : 0;
    if (tick === 0) return [[0xfa]];
    if (clocked) return [];
    if (tick % 6 !== 0) return undefined;
    const sixteenths = tick / 6;
    if (sixteenths > 0x3fff) {
      report('the clock joined past the last song position MIDI can say: PAM continues from where it was. resetCycles starts it from the top');
      return [[0xfb]];
    }
    return [[0xf2, sixteenths & 0x7f, sixteenths >> 7], [0xfb]];
  }

  function out(bytes, whenMs) {
    if ((bytes[0] & 0xf0) === 0x90) channels.add(bytes[0] & 0x0f);
    send(bytes, whenMs);
    counters.sent++;
  }

  /** All notes off on every channel a note went to, and MIDI stop if the clock was running. */
  function hush(whenMs) {
    for (const channel of channels) out([0xb0 | channel, 123, 0], whenMs);
    if (clocked) out([0xfc], whenMs);
    clocked = false;
    lastTick = undefined;
    encoder.forget();
  }

  function play({ args, time }) {
    const read = tidalValue(args);
    if (read.setup !== undefined) use(read.setup);
    read.problems.forEach(report);
    const { events, problems } = compileValue(read.value, setup);
    problems.forEach(report);
    const base = time + latencyMs;
    // A stop that was asked for is sent whether or not a clock was running here.
    if (events.some((e) => e.type === 'transport' && e.command === 'stop')) {
      clocked = true;
      hush(base);
      return;
    }
    const ticking = events.some(isClockTick);
    const start = ticking ? clockStart(read.cycle, read.steps) : [];
    if (ticking && start) {
      clocked = true;
      lastTick = Math.max(lastTick ?? 0, base);
    }
    const sending = start ? events : events.filter((e) => !isClockTick(e));
    for (const bytes of start ?? []) out(bytes, base);
    for (const { bytes, at } of encoder.encode(sending, read.seconds)) out(bytes, base + at * 1000);
  }

  return {
    /**
     * Takes one UDP packet. Its events wait for `flush`, so that a batch can be put in order first.
     * @param {Uint8Array} packet
     * @param {number} arrivalMs Unix milliseconds now: the time of an event that came with none
     */
    receive(packet, arrivalMs) {
      let messages;
      try {
        messages = decodePacket(packet);
      } catch (err) {
        report(err.message);
        return;
      }
      for (const message of messages) {
        const marked = message.args.some((arg, i) => i % 2 === 0 && arg === TIDAL_MARK);
        if (message.address !== TIDAL_ADDRESS || !marked) {
          counters.ignored++;
          continue;
        }
        counters.messages++;
        pending.push({ args: message.args, time: message.time ?? arrivalMs });
      }
    },
    /**
     * Sends what has been received, in the order of its times, with a variation or preset switch
     * before the others of its time: PAM answers a switch by bringing back that variation's own
     * mutes and knob values, so what the pattern sets for the same bar is worked out after the switch.
     */
    flush() {
      const due = pending;
      pending = [];
      const recalls = ({ args }) => (args.some((arg, i) => i % 2 === 0 && (arg === 'variation' || arg === 'progNum')) ? 0 : 1);
      due.sort((a, b) => a.time - b.time || recalls(a) - recalls(b));
      due.forEach(play);
    },
    /** Call now and then: stops PAM's transport once the clock pattern has gone quiet. */
    idle(nowMs) {
      if (clocked && lastTick !== undefined && nowMs > lastTick + CLOCK_SILENCE_MS) hush(nowMs);
    },
    hush,
    /** Describe the PAM being played, as `pamsetup` does. */
    use,
    status() {
      return { setup, options, port, clocked, ...counters, problems: [...reported] };
    },
  };
}
