/*
play-page.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// A stand-in for a browser with PAM's play page in it, for the tests. The page speaks version 1
// of PAM's play interface as PAM's specification describes it: the handshake, an `ack` for every
// request, and a refusal code for every event that a PAM would not play. It makes no sound and
// records what it would have played.
//
// The page can be reached in each of the ways the interface travels: as a tab that the sender
// opened, and by a data channel paired under a room code. For the second there is a stand-in for
// WebRTC's peer connection and for the pairing endpoint of PAM's site.

import { createSignalling } from '../../src/pam/play-rtc.mjs';

export const PAM_ORIGIN = 'https://map.audio';
export const CHANNEL = 'pam-play-v1';
export const TIME_ORIGIN = 1_794_938_000_000;

const FIELDS = {
  note: ['cell', 'note', 'velocity', 'duration'],
  param: ['paramId', 'value'],
  variation: ['index', 'sync'],
  transport: ['action', 'ppqPosition', 'bpm'],
  mute: ['cell', 'on'],
  solo: ['cell', 'on'],
};

const cell = (number, more = {}) => ({ cell: number, armed: true, pitched: false, rootNote: 48, noteMin: 0, noteMax: 127, ...more });

/** What the stand-in PAM has until a test says otherwise. */
export const defaultPam = () => ({
  origin: PAM_ORIGIN,
  protocol: 1,
  allow: 'yes', // what the person at the PAM tab answers: 'yes', 'no', or 'ask' to leave the question open
  leadMs: 40,
  welcomeLeadMs: undefined, // what the welcome says, where it differs from what PAM's answers say
  crossingMs: 0, // how long a message takes to reach PAM: its page was busy
  clockAheadMs: 0, // how far PAM's page clock is ahead of the sender's: the two pages were loaded at different times
  trip: { there: 0, back: 0 }, // how long a getTransport takes each way, in milliseconds that then pass
  trips: undefined, // the same for the next ones only, one after another
  audio: 'running',
  pings: true, // false: a PAM from before `ping`, which calls it an unknown kind
  preset: 'night-shift',
  presets: ['night-shift', 'cold-rail', 'haze-garden'],
  cells: [cell(1), cell(2), cell(3), cell(4, { armed: false }), cell(5, { pitched: true, rootNote: 36 }), cell(6), cell(7, { pitched: true }), cell(8, { pitched: true })],
  emptyVariations: [7],
  parameters: {
    cell: [
      { id: 'filterCutoff', min: 20, max: 20000, default: 8000, step: 1, unit: 'Hz', continuous: true },
      { id: 'volume', min: -60, max: 12, default: 0, step: 0.01, unit: 'dB', continuous: true },
      { id: 'delayMix', min: 0, max: 100, default: 0, step: 0.1, unit: '%', continuous: true },
      { id: 'synth_p1', min: 0, max: 1, default: 0.5, step: 0, continuous: true },
    ],
    global: [
      { id: 'volume', min: -60, max: 12, default: 0, step: 0.01, unit: 'dB', continuous: true },
      { id: 'macro_filterCutoff', min: 20, max: 20000, default: 20000, step: 1, unit: 'Hz', continuous: true },
    ],
  },
  limits: { eventsPerMessage: 256, eventsPerSecond: 500, lookaheadMs: 2000, scheduledNotes: 512, noteDurationMs: 60000, rampDurationMs: 60000, concurrentRamps: 32, bpmMin: 20, bpmMax: 999 },
});

// What a peer connection and its data channel listen with.
class Heard {
  #listeners = new Map();
  addEventListener(type, listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type, listener) {
    this.#listeners.set(type, (this.#listeners.get(type) ?? []).filter((kept) => kept !== listener));
  }
  emit(type, event = {}) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

// WebRTC as two pages on one computer see it: peer connections that find each other by the
// descriptions they exchange, and a data channel between the two of a pair.
function createNetwork() {
  const net = {
    made: [], // every peer connection, in the order they were made
    gathers: true, // false: the browser never finishes gathering addresses
    blocked: false, // true: descriptions are exchanged and the connection fails
    unresolved: false, // true: descriptions are exchanged and the other tab's .local names are never found, so nothing happens at all
    sdpBytes: 0, // how long an offer's description is made, for a computer with many network addresses
  };
  class Channel extends Heard {
    readyState = 'connecting';
    constructor(label, options) {
      super();
      Object.assign(this, { label, options });
    }
    send(text) {
      if (this.readyState !== 'open') throw new Error('InvalidStateError: the channel is not open');
      const { other } = this;
      queueMicrotask(() => other.readyState === 'open' && other.emit('message', { data: text }));
    }
    close() {
      for (const end of [this, this.other]) {
        if (!end || end.readyState === 'closed') continue;
        end.readyState = 'closed';
        queueMicrotask(() => end.emit('close'));
      }
    }
  }
  net.Peer = class Peer extends Heard {
    iceGatheringState = 'new';
    connectionState = 'new';
    localDescription = null;
    remoteDescription = null;
    constructor(config) {
      super();
      this.config = config;
      this.id = net.made.push(this);
    }
    createDataChannel(label, options) {
      this.channel = new Channel(label, options);
      return this.channel;
    }
    async createOffer() {
      return { type: 'offer', sdp: `stand-in ${this.id} `.padEnd(net.sdpBytes, 'a') };
    }
    async createAnswer() {
      return { type: 'answer', sdp: `stand-in ${this.id}` };
    }
    async setLocalDescription(description) {
      this.localDescription = description;
      this.iceGatheringState = 'gathering';
      if (net.gathers) {
        queueMicrotask(() => {
          this.iceGatheringState = 'complete';
          this.emit('icegatheringstatechange');
        });
      }
      join(this);
    }
    async setRemoteDescription(description) {
      // The side that offered takes an answer, and the other side an offer.
      const expected = this.localDescription?.type === 'offer' ? 'answer' : 'offer';
      if (description.type !== expected || typeof description.sdp !== 'string') throw new Error(`InvalidAccessError: a description of type ${description.type} where ${expected} was due`);
      this.remoteDescription = description;
      this.remote = net.made[Number(description.sdp.split(' ')[1]) - 1];
      join(this);
    }
    close() {
      this.connectionState = 'closed';
      this.channel?.close();
    }
  };
  // Two peers are joined once each holds its own description and the other's.
  function join(peer) {
    const other = peer.remote;
    if (!other || other.remote !== peer || !peer.localDescription || !other.localDescription) return;
    const [offerer, answerer] = peer.localDescription.type === 'offer' ? [peer, other] : [other, peer];
    queueMicrotask(() => {
      if (offerer.connectionState === 'closed' || answerer.connectionState === 'closed') return;
      if (net.unresolved) return;
      const state = net.blocked ? 'failed' : 'connected';
      for (const end of [offerer, answerer]) {
        end.connectionState = state;
        end.emit('connectionstatechange');
      }
      if (net.blocked) return;
      const far = new Channel(offerer.channel.label, offerer.channel.options);
      far.other = offerer.channel;
      offerer.channel.other = far;
      answerer.channel = far;
      answerer.emit('datachannel', { channel: far });
      for (const end of [offerer.channel, far]) {
        end.readyState = 'open';
        end.emit('open');
      }
    });
  }
  return net;
}

// The browser's own names that strudel.cc puts Strudel's patterns and functions in place of: every
// export of the modules that its REPL hands to `evalScope`, read from Strudel's main branch on
// 2026-11-18, that is also a name of the window's.
export const STRUDEL_SHADOWS = ['open', 'close', 'focus', 'frames'];

/**
 * A browser as the sending page sees it: its own `window` and `document`, a clock that the test
 * sets, tabs, WebRTC, and PAM's site as far as pairing asks it. `pam` describes the PAM that the
 * next page loads.
 */
export function createBrowser() {
  const heard = { message: [], pagehide: [] };
  const rooms = new Map(); // what PAM's site holds for each code: { offer, answer }
  const browser = {
    // `creep` is how far the page's clock moves each time it is read, as a real one does.
    clock: { ms: 1000, creep: 0 },
    pam: defaultPam(),
    pages: [], // every PAM page, in the order they were made
    opened: [],
    blocked: false, // true: the browser opens no tab for the sending page
    cutsOpener: false, // true: the sending page is kept apart from tabs of other sites
    threeArgumentOpen: true, // false: a browser whose `document.open` has only the form that clears the page
    throwawayRefuses: undefined, // the name of an error that such a browser gives for a document with no window
    cleared: false, // whether the sending page was cleared by `document.open`
    origin: 'https://sequencer.example', // the sending page's own site
    // The sending page itself: what its server answers when the page asks for its own address,
    // and after how long. `coop` is its Cross-Origin-Opener-Policy header, if it sends one.
    page: { address: 'https://sequencer.example/play', coop: undefined, status: 200, reachable: true, delayMs: 0 },
    pageRequests: [], // the requests for the page's own address: [method, address]
    requests: [], // what PAM's site was asked: [method, path and query, body]
    // `refuses` is [status, code] for a site that answers every request with an error. `busy` makes
    // its next `times` answers to the sending page a 429 with that `Retry-After`, and with no body.
    site: { reachable: true, refuses: undefined, busy: undefined },
    rtc: createNetwork(),
    now: () => TIME_ORIGIN + browser.clock.ms,
    // A message crosses between windows in a task of its own, never inside the call that posts it.
    deliver: (event) => queueMicrotask(() => heard.message.forEach((listener) => listener(event))),
    window: {
      opener: null,
      addEventListener: (type, listener) => (heard[type] ??= []).push(listener),
      open: (address, name) => opens(address, name),
    },
  };
  browser.tabs = browser.pages;

  function opens(address, name) {
    browser.opened.push([address, name]);
    if (browser.blocked) return null;
    const kept = browser.pages.find((page) => page.name === name && !page.window.closed);
    if (kept) return kept.window;
    const page = createPage(browser, browser.pam, name);
    if (address) page.window.location.href = address;
    return page.window;
  }
  // A document's `open` has two forms, told apart by how many arguments it is given. With three
  // it opens a tab as the window's `open` does, and refuses on a document that has no window.
  // With fewer it clears the document for writing.
  const opening = (document, windowed) => (...args) => {
    if (args.length === 3 && browser.threeArgumentOpen) {
      if (!windowed) throw new DOMException('The document has no window associated.', 'InvalidAccessError');
      return opens(args[0], args[1]);
    }
    if (windowed) browser.cleared = true;
    else if (browser.throwawayRefuses) throw new DOMException('This document cannot be opened.', browser.throwawayRefuses);
    return document;
  };
  browser.document = {
    implementation: {
      createHTMLDocument() {
        const made = {};
        made.open = opening(made, false);
        return made;
      },
    },
  };
  browser.document.open = opening(browser.document, true);
  /**
   * The sending page runs Strudel, which puts its patterns where the browser's own names were.
   * `functions` puts functions that make a pattern there, as Strudel's registered functions are.
   */
  browser.runsStrudel = ({ functions = false } = {}) => {
    for (const name of STRUDEL_SHADOWS) {
      const pattern = { _Pattern: true };
      const shadow = functions ? () => pattern : pattern;
      browser.window[name] = shadow;
      browser.env[name] = shadow;
    }
  };

  // The pairing endpoint of PAM's site, as PAM's document describes it: for each room at most one
  // offer and one answer. Reading one does not remove it. A request with `wait` is held until
  // there is something to give or the wait is over.
  const waiters = new Set();
  const nothing = { ok: true, status: 204, headers: { get: () => null } };
  const headers = (held = {}) => ({ get: (name) => held[name.toLowerCase()] ?? null });
  const refuse = (status, code) => ({ ok: false, status, headers: headers(), json: async () => ({ error: { code, message: `the stand-in says ${code}` } }) });
  // `caller` is 'pam' for a request from one of PAM's own pages, and the sending page otherwise.
  const ask = async (address, { method = 'GET', body, signal } = {}, caller = 'sender') => {
    const url = new URL(address);
    if (address === browser.page.address) {
      browser.pageRequests.push([method, address]);
      if (browser.page.delayMs) await new Promise((resolve) => setTimeout(resolve, browser.page.delayMs));
      if (!browser.page.reachable) throw new TypeError('Failed to fetch');
      const sent = browser.page.coop === undefined ? {} : { 'cross-origin-opener-policy': browser.page.coop };
      return { ok: browser.page.status === 200, status: browser.page.status, headers: headers(sent) };
    }
    browser.requests.push([method, `${url.pathname}${url.search}`, ...(body === undefined ? [] : [JSON.parse(body)])]);
    if (!browser.site.reachable || url.origin !== browser.pam.origin) throw new TypeError('Failed to fetch');
    if (browser.site.refuses) return refuse(...browser.site.refuses);
    if (caller === 'sender' && browser.site.busy?.times > 0) {
      browser.site.busy.times--;
      const retry = browser.site.busy.retryAfter === undefined ? {} : { 'retry-after': String(browser.site.busy.retryAfter) };
      return { ok: false, status: 429, headers: headers(retry), json: async () => JSON.parse('not JSON') };
    }
    const [, room, what] = /^\/api\/play\/v1\/rooms\/([^/]+)\/(offer|answer)$/.exec(url.pathname) ?? [];
    if (!what) return refuse(404, 'not_found');
    if (!/^[A-Za-z0-9_-]{22,64}$/.test(room)) return refuse(400, 'invalid_request');
    const held = rooms.get(room) ?? rooms.set(room, {}).get(room);
    if (method === 'PUT') {
      if (new TextEncoder().encode(body).length > 8000) return refuse(413, 'too_large');
      const { sdp } = JSON.parse(body);
      if (typeof sdp !== 'string') return refuse(400, 'invalid_request');
      held[what] = what === 'offer' ? { sdp, origin: browser.origin } : { sdp };
      // PAM's answer removes the offer, and the sender's next offer removes the answer.
      if (what === 'offer') delete held.answer;
      if (what === 'answer') delete held.offer;
      for (const waiter of [...waiters]) if (waiter.room === room && waiter.what === what) waiter.give();
      return nothing;
    }
    // Reading leaves an entry where it is.
    const read = () => {
      const entry = held[what];
      return { ok: true, status: 200, headers: headers(), json: async () => entry };
    };
    if (held[what]) return read();
    const wait = Math.min(25, Number(url.searchParams.get('wait') ?? 0));
    if (!(wait > 0)) return nothing;
    return new Promise((resolve, reject) => {
      const end = (settle, value) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        signal?.removeEventListener('abort', aborted);
        settle(value);
      };
      const waiter = { room, what, give: () => end(resolve, read()), over: () => end(resolve, nothing) };
      const aborted = () => end(reject, new DOMException('The operation was aborted.', 'AbortError'));
      const timer = setTimeout(waiter.over, wait * 1000);
      signal?.addEventListener('abort', aborted);
      waiters.add(waiter);
    });
  };
  browser.fetch = (address, init) => ask(address, init);
  browser.pamFetch = (address, init) => ask(address, init, 'pam');
  /** The test is over: every page is closed, and nothing is left waiting at PAM's site. */
  browser.close = () => {
    for (const page of browser.pages) page.gone = true;
    for (const waiter of [...waiters]) waiter.over();
  };

  browser.env = {
    window: browser.window,
    document: browser.document,
    // The page's address as it reads it: a REPL keeps its code after the #.
    location: { href: `${browser.page.address}#bm90ZSgiYzIiKQ` },
    performance: {
      timeOrigin: TIME_ORIGIN,
      now: () => {
        const read = browser.clock.ms;
        browser.clock.ms += browser.clock.creep;
        return read;
      },
    },
    fetch: browser.fetch,
    RTCPeerConnection: browser.rtc.Peer,
    crypto: globalThis.crypto,
  };

  /** A PAM tab that is already open and loaded, as one left from before the sending page was loaded again. */
  browser.keepTab = (name = 'pam-play') => {
    const page = createPage(browser, browser.pam, name);
    page.window.location.href = `${browser.pam.origin}/pam/play`;
    return page;
  };
  /** A PAM page that waits under a code, as the one that gave the code out does. */
  browser.arm = (room) => {
    const page = createPage(browser, browser.pam, '');
    page.window.location.href = `${browser.pam.origin}/pam/play#room=${room}`;
    return page;
  };
  /** The person opens an address by hand, in a tab that no page opened. */
  browser.visit = (address) => {
    const page = createPage(browser, browser.pam, '');
    page.byHand = true;
    page.window.location.href = address;
    return page;
  };
  return browser;
}

function createPage(browser, pam, name) {
  let loaded = false;
  let connected = false;
  let asking = [];
  let state;
  let peer;
  let channel;
  let listening; // stops the wait for an offer when the page is closed or loaded again
  // `switches` has each variation switch that PAM took: how long before its time it arrived, and what rode it.
  const page = { name, pam, received: [], addressedTo: new Set(), played: [], rode: [], switches: [], ignored: 0, loads: 0, address: undefined, room: undefined, gone: false };

  // PAM answers by the way the sender reached it: its data channel while one is open, else its window.
  function post(data) {
    const message = { channel: CHANNEL, ...data };
    if (channel?.readyState === 'open') return channel.send(JSON.stringify(message));
    if (page.cut || page.byHand) return undefined;
    return browser.deliver({ origin: pam.origin, source: page.window, data: message });
  }

  // PAM's own reading of the shared clock.
  const now = () => browser.now() + pam.clockAheadMs;
  const transport = (received = now()) => ({ playing: false, bpm: 120, ppqPosition: 0, timeSigNumerator: 4, timeSigDenominator: 4, time: received, received });
  const welcome = () => ({
    protocol: pam.protocol,
    product: 'pam',
    version: '1.9.0',
    cells: structuredClone(state.cells),
    parameters: structuredClone(pam.parameters),
    variations: 8,
    limits: { ...pam.limits },
    timing: { leadMs: pam.welcomeLeadMs ?? pam.leadMs, controlLeadMs: 8, sampleRate: 48000, blockSize: 128 },
    presets: [...pam.presets],
    preset: state.preset,
    transport: transport(),
  });

  function parameter(id) {
    const own = /^cell(\d+)_(.+)$/.exec(String(id));
    if (own) return state.cells[Number(own[1]) - 1] && pam.parameters.cell.find((p) => p.id === own[2]);
    return pam.parameters.global.find((p) => p.id === id);
  }

  // The refusal for one event, or nothing when a PAM would play it.
  function judge(event) {
    const fields = FIELDS[event?.type];
    if (!fields) return { code: 'invalid_event' };
    const unknown = Object.keys(event).find((key) => key !== 'type' && key !== 'time' && !fields.includes(key));
    if (unknown) return { code: 'invalid_event', field: unknown };
    if (event.time !== undefined && !Number.isFinite(event.time)) return { code: 'invalid_event', field: 'time' };
    const at = state.cells[event.cell - 1];
    if (event.type === 'note') {
      if (!at) return { code: 'unknown_cell' };
      if (!at.armed) return { code: 'cell_not_armed' };
      if (event.note !== undefined && !at.pitched) return { code: 'cell_not_pitched' };
      if (event.note !== undefined && !Number.isInteger(event.note)) return { code: 'invalid_event', field: 'note' };
      if (event.note < at.noteMin || event.note > at.noteMax) return { code: 'out_of_range', min: at.noteMin, max: at.noteMax };
      if (event.velocity !== undefined && !(event.velocity > 0 && event.velocity <= 1)) return { code: 'invalid_event', field: 'velocity' };
      if (!(event.duration > 0)) return { code: 'invalid_event', field: 'duration' };
      if (event.duration > pam.limits.noteDurationMs) return { code: 'limit_exceeded', limit: 'noteDurationMs' };
    } else if (event.type === 'param') {
      const found = parameter(event.paramId);
      if (!found) return { code: 'unknown_parameter' };
      if (!Number.isFinite(event.value)) return { code: 'invalid_event', field: 'value' };
      if (event.value < found.min || event.value > found.max) return { code: 'out_of_range', min: found.min, max: found.max };
    } else if (event.type === 'variation') {
      if (!Number.isInteger(event.index) || event.index < 0 || event.index > 7) return { code: 'out_of_range', min: 0, max: 7 };
      if (event.sync !== undefined && typeof event.sync !== 'boolean') return { code: 'invalid_event', field: 'sync' };
      if (pam.emptyVariations.includes(event.index)) return { code: 'variation_empty' };
    } else if (event.type === 'transport') {
      if (!['play', 'pause', 'stop', 'seek'].includes(event.action)) return { code: 'invalid_event', field: 'action' };
      if (event.action === 'seek' && !Number.isFinite(event.ppqPosition)) return { code: 'invalid_event', field: 'ppqPosition' };
      if (event.bpm !== undefined && !(event.bpm >= pam.limits.bpmMin && event.bpm <= pam.limits.bpmMax)) return { code: 'out_of_range', min: pam.limits.bpmMin, max: pam.limits.bpmMax };
    } else {
      if (!at) return { code: 'unknown_cell' };
      if (typeof event.on !== 'boolean') return { code: 'invalid_event', field: 'on' };
    }
    if (event.time === undefined) return undefined;
    const lead = event.time - (now() + pam.crossingMs);
    if (lead < pam.leadMs) return { code: 'too_late', lateByMs: pam.leadMs - lead };
    if (lead > pam.limits.lookaheadMs) return { code: 'too_far_ahead' };
    return undefined;
  }

  function receive(data) {
    page.received.push(data);
    if (data?.channel !== CHANNEL) return undefined;
    const { kind, id } = data;
    const ack = (result) => post({ kind: 'ack', id, ok: true, ...(result === undefined ? {} : { result }) });
    const refuse = (code, more = {}) => post({ kind: 'ack', id, ok: false, error: { code, message: `the stand-in says ${code}`, ...more } });
    const welcomed = () => {
      connected = true;
      ack(welcome());
    };
    // A ping is answered at once, from any page and before any question.
    if (kind === 'ping') return pam.pings === false ? refuse('unknown_kind') : ack({ protocol: pam.protocol });
    if (kind === 'hello') {
      if (data.protocol !== pam.protocol) return refuse('unsupported_version', { protocol: pam.protocol });
      // The connected sender is welcomed afresh with no question, and a hello that comes while the
      // question is open joins it: one question, and each hello answered when the person chooses.
      if (connected) return welcomed();
      if (pam.allow === 'ask') return asking.push({ welcomed, refuse });
      return pam.allow === 'no' ? refuse('access_denied') : welcomed();
    }
    if (!connected) return refuse('not_connected');
    if (kind === 'flush') return ack();
    if (kind === 'bye') {
      connected = false;
      return ack();
    }
    if (kind === 'getTransport') {
      const trip = pam.trips?.shift() ?? pam.trip;
      const received = now() + trip.there;
      browser.clock.ms += trip.there + trip.back;
      return ack(transport(received));
    }
    if (kind === 'loadPreset') {
      if (!pam.presets.includes(data.slug)) return refuse('unknown_preset');
      state.preset = data.slug;
      ack({ preset: state.preset, cells: structuredClone(state.cells) });
      return post({ kind: 'preset', preset: state.preset, cells: structuredClone(state.cells) });
    }
    if (kind !== 'events') return refuse('unknown_kind');
    if (!Array.isArray(data.events)) return refuse('invalid_message');
    if (data.events.length > pam.limits.eventsPerMessage) return refuse('limit_exceeded', { limit: 'eventsPerMessage' });
    if (pam.audio === 'blocked') return refuse('audio-blocked');
    const refused = [];
    // What comes after a variation switch in the same message, with the same time, rides the switch.
    const switches = new Map();
    data.events.forEach((event, index) => {
      const no = judge(event);
      if (no) refused.push({ index, message: `the stand-in says ${no.code}`, ...no });
      else page.played.push(event);
      if (event?.type === 'variation' && event.time !== undefined) {
        switches.set(event.time, { index: event.index, time: event.time, noticeMs: event.time - (now() + pam.crossingMs), rode: [] });
        if (!no) page.switches.push(switches.get(event.time));
      } else if (!no && ['mute', 'solo', 'param'].includes(event.type) && switches.has(event.time)) {
        page.rode.push(event);
        switches.get(event.time).rode.push(event);
      }
    });
    return ack({ accepted: data.events.length - refused.length, refused, leadMs: pam.leadMs, received: now() + pam.crossingMs });
  }

  page.window = {
    closed: false,
    location: {},
    postMessage(data, targetOrigin) {
      // An empty tab is still on the sender's own origin, so a message addressed to PAM's is not
      // delivered. Nor is one to a tab that has gone to a page of another site.
      if (page.window.closed || !loaded || page.elsewhere || (targetOrigin !== '*' && targetOrigin !== pam.origin)) return;
      page.addressedTo.add(targetOrigin);
      receive(structuredClone(data));
    },
  };
  // The sender can read the address of the empty tab that it opened, and not that of PAM's page.
  Object.defineProperty(page.window.location, 'href', {
    get() {
      if (loaded) throw new Error('SecurityError: this page is on another origin');
      return 'about:blank';
    },
    set(address) {
      page.address = address;
      page.elsewhere = false;
      // A sending page served with Cross-Origin-Opener-Policy: same-origin loses the tab as it loads
      // another site: its handle reads as closed, and the page in the tab has no opener to answer.
      if (browser.cutsOpener) {
        page.window.closed = true;
        page.cut = true;
      }
      page.reload();
    },
  });

  // PAM's page waits at the endpoint for an offer under its room, and answers it. While a sender
  // is connected it does not look for offers. When the channel closes it lets go of the sender and
  // listens again for the same room.
  async function listen() {
    listening?.abort();
    const mine = new AbortController();
    listening = mine;
    const signalling = createSignalling({ origin: pam.origin, fetch: browser.pamFetch });
    const current = () => !mine.signal.aborted && !page.gone;
    while (current()) {
      let offer;
      try {
        offer = await signalling.getOffer(page.room, 20, mine.signal);
      } catch {
        return;
      }
      if (!current()) return;
      if (!offer) continue;
      page.offerOrigin = offer.origin;
      peer = new browser.rtc.Peer();
      peer.addEventListener('datachannel', (event) => {
        channel = event.channel;
        // PAM ignores a frame that is longer than it takes, or that is not JSON.
        channel.addEventListener('message', (message) => {
          if (new TextEncoder().encode(message.data).length > 200000) return void page.ignored++;
          receive(JSON.parse(message.data));
        });
        channel.addEventListener('close', () => {
          connected = false;
          if (current()) listen();
        });
      });
      await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await peer.setLocalDescription(await peer.createAnswer());
      await signalling.putAnswer(page.room, peer.localDescription.sdp);
      return;
    }
  }

  /** The page loads, or loads again: PAM forgets who was allowed, says `ready`, and listens under the room in its address. */
  page.reload = () => {
    loaded = true;
    connected = false;
    asking = [];
    page.loads++;
    listening?.abort();
    peer?.close();
    peer = undefined;
    channel = undefined;
    const address = page.address ? new URL(page.address) : undefined;
    const asked = address?.searchParams.get('preset');
    state = { cells: structuredClone(pam.cells), preset: pam.presets.includes(asked) ? asked : pam.preset };
    page.room = /^#room=(.+)$/.exec(address?.hash ?? '')?.[1];
    post({ kind: 'ready', protocol: pam.protocol, product: 'pam' });
    if (page.room) listen();
  };
  /** The person at the PAM tab answers the question that every waiting `hello` asked. */
  page.allow = () => asking.splice(0).forEach((asked) => asked.welcomed());
  page.deny = () => asking.splice(0).forEach((asked) => asked.refuse('access_denied'));
  /** The person presses the button that disconnects the sender. Over a data channel PAM then closes the channel. */
  page.disconnect = (reason) => {
    connected = false;
    post({ kind: 'status', connected: false, audio: pam.audio, engine: 'running', ...(reason ? { reason } : {}) });
    if (channel?.readyState === 'open') queueMicrotask(() => peer.close());
  };
  /** The person closes the tab. */
  page.close = () => {
    page.window.closed = true;
    page.gone = true;
    listening?.abort();
    peer?.close();
  };
  /** PAM drops the sender and says nothing, so the sender learns it from its next answer. */
  page.forget = () => {
    connected = false;
  };
  /** PAM says something of its own accord. */
  page.say = (notice) => post(notice);
  /** Something that is not a message of the interface arrives on the data channel. */
  page.sendRaw = (text) => channel.send(text);
  /** The person loads another preset in PAM. */
  page.load = (preset, cells = state.cells) => {
    state = { preset, cells: structuredClone(cells) };
    post({ kind: 'preset', preset, cells: structuredClone(cells) });
  };
  page.kinds = () => page.received.map((message) => message.kind);
  page.messages = (kind) => page.received.filter((message) => message.kind === kind);
  browser.pages.push(page);
  return page;
}
