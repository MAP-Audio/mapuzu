/*
play.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The sending side of PAM's play interface, version 1: how a web page plays a PAM that runs in
// another tab of the same browser, with no MIDI. PAM publishes the interface (the channel
// `pam-play-v1`), and this file is written from that document.
//
// Like the MIDI encoder beside it, it knows no pattern language: a binding hands it PAM events
// with a time, and it holds the connection, sends them and keeps count of what PAM answered.
//
// The messages are the same whichever way they travel. The document has two ways, and each one is
// a port: an object with `post(message)`, `closed` and `close()`, which calls `onmessage` with each
// message from PAM and `onclose` if it learns that it has closed.
//
//   a tab       `postMessage` to a PAM tab that this page opened
//   a channel   a WebRTC data channel, paired under a room code (play-rtc.mjs): for a page that the
//               browser keeps apart from tabs of other sites, where no `postMessage` crosses

import { byteLength, createSignalling, isRoom, makeRoom, pair } from './play-rtc.mjs';

/** The channel name every message carries, and the protocol version this file speaks. */
export const PLAY_CHANNEL = 'pam-play-v1';
export const PLAY_PROTOCOL = 1;
/** The path of PAM's play page on a site that serves PAM. */
export const PLAY_PAGE = '/pam/play';

const PLAY_WINDOW = 'pam-play';
// Kept on top of PAM's own lead, for the message to cross from this tab to PAM's.
const MARGIN_MS = 15;
// A change in what PAM needs that is worth moving everything for. Less than this is the lead's own flutter.
const LEAD_STEP_MS = 20;
// How long a tab that was found open has to answer a `ping` before it is taken not to be PAM.
const PING_WAIT_MS = 1500;
// The lead that is planned for until PAM has said its own in an answer to `events`. A welcome sent
// before PAM's audio started gives a figure that is too low (9 ms where the answers then said 75).
const UNMEASURED_LEAD_MS = 100;
// How long PAM has to answer a pairing: a PAM that gave the code is already waiting, and one that
// this page opens has to load first, or be opened by hand where the browser blocked the tab.
const ANSWER_WAIT_MS = { given: 15000, own: 120000 };
// When pairing again under this page's own code, how long before PAM's tab is taken to be gone and is opened again.
const OPEN_AGAIN_MS = 3000;
// How long the page's own headers are waited for before PAM's tab is opened without them. A tab
// opens only while the key press that asked for it still counts. Chrome and Firefox count 5
// seconds from the key press. Safari carries the key press into a timer of at most 1 second and
// into the answer to a request, so the wait is under a second and the answer itself opens the tab.
const POLICY_WAIT_MS = 800;

const HINTS = {
  'audio-blocked': 'click in the PAM tab so that it can make sound',
  engine_unavailable: "PAM's audio engine is starting or has stopped: look at the PAM tab",
  cell_not_armed: 'arm the cell in PAM',
  cell_not_pitched: 'the cell plays one pitch in this preset: leave note and n out, or make it poly',
  cell_shares_trigger: 'give the cells MIDI channels of their own in the preset',
  rate_limited: 'send fewer events a second',
};

const isHttp = (url) => url.protocol === 'https:' || url.protocol === 'http:';

/**
 * Which PAM to play, from `pamsetup`'s `web` option.
 *
 * @param {true | string | { site?: string, room?: string }} web `true` for the PAM of the site
 *   this module was imported from, PAM's address, or `{ room }` to pair with the PAM page that
 *   waits under that code (`site` beside it names a PAM that is not the importing site's)
 * @param {string} [home] the address this module was imported from (`import.meta.url`)
 * @returns {{ page: string, origin: string, room?: string }}
 */
export function playTarget(web, home) {
  const said = web !== null && typeof web === 'object' ? web : { site: web };
  const unknown = Object.keys(said).filter((key) => key !== 'site' && key !== 'room');
  if (unknown.length) throw new Error(`web: { ${unknown.join(', ')} } is not something it takes. It takes { room: 'the code from PAM' } and { site: 'https://map.audio' }`);
  const { site = true, room } = said;
  let url;
  if (site === true) {
    try {
      url = new URL(PLAY_PAGE, home);
    } catch {
      url = undefined;
    }
    if (!url || !isHttp(url)) {
      throw new Error("web plays the PAM of the site that mapuzu.mjs was imported from, and this copy was not imported from a site. Give PAM's address: pamsetup({ web: 'https://map.audio' })");
    }
  } else {
    try {
      url = new URL(String(site));
    } catch {
      url = undefined;
    }
    if (!url || !isHttp(url)) {
      throw new Error(`web: ${JSON.stringify(site)} is not the address of a PAM page. Write it whole, in single quotes: pamsetup({ web: 'https://map.audio' })`);
    }
    if (url.pathname === '/') url.pathname = PLAY_PAGE;
  }
  if (room === undefined) return { page: url.href, origin: url.origin };
  if (!isRoom(String(room))) {
    throw new Error(`web: { room: ${JSON.stringify(room)} } is not a code from a PAM page. Copy the line that PAM's page gives, with its single quotes`);
  }
  return { page: url.href, origin: url.origin, room: String(room) };
}

// Asks whether the browser keeps this page apart from tabs of other sites, and calls `answer`
// with true, false, or nothing when it cannot be told. A page served with a
// `Cross-Origin-Opener-Policy` other than `unsafe-none` loses every tab of another site that it
// opens, so no `postMessage` crosses to a PAM tab from it. A page has no way to read its own
// headers but to ask for itself again.
function askOpenerPolicy(env, answer) {
  const address = String(env.location?.href ?? '').split('#')[0];
  if (!/^https?:/.test(address) || typeof env.fetch !== 'function') return answer(undefined);
  let asked;
  try {
    asked = env.fetch(address, { method: 'HEAD' });
  } catch {
    return answer(undefined);
  }
  return asked.then(
    (response) => {
      if (!response.ok) return answer(undefined);
      const policy = String(response.headers.get('Cross-Origin-Opener-Policy') ?? 'unsafe-none').split(';')[0].trim().toLowerCase();
      return answer(policy !== 'unsafe-none');
    },
    () => answer(undefined),
  );
}

function withPreset(page, slug) {
  const url = new URL(page);
  url.searchParams.set('preset', slug);
  return url.href;
}

/**
 * PAM events, as `compileValue` returns them, as events of the play interface. A variation switch
 * goes first and notes go last, so that what an event sets is in place when its note starts.
 *
 * @param {import('./events.mjs').PamEvent[]} events one pattern event's worth, without clock ticks
 * @param {object} at
 * @param {number} [at.time] when the event is heard, in milliseconds on the clock that the tabs of
 *   one browser share (`performance.timeOrigin + performance.now()`). Left out: as soon as PAM can
 * @param {number} [at.duration] the event's length in milliseconds, for a note's release
 * @param {{ rootNote: number }[]} [at.cells] the welcome's cells, for `n` above a cell's root
 * @returns {{ events: object[], unsupported: string[] }} `unsupported` says what the interface
 *   has no event for. Those are left out, never sent as something else
 */
export function toPlayEvents(events, { time, duration = 0, cells = [] } = {}) {
  const first = [];
  const controls = [];
  const notes = [];
  const unsupported = [];
  const at = time === undefined ? {} : { time };
  for (const event of events) {
    switch (event.type) {
      case 'variation':
        // mapuzu counts variations from 1, as PAM's window does. The interface counts from 0.
        first.push({ type: 'variation', ...at, index: event.index - 1 });
        break;
      case 'knob':
        controls.push({ type: 'param', ...at, paramId: event.param.id, value: event.value });
        break;
      case 'switch':
        controls.push({ type: event.what, ...at, cell: event.cell, on: event.on });
        break;
      case 'transport':
        if (event.command === 'start') controls.push({ type: 'transport', ...at, action: 'seek', ppqPosition: 0 }, { type: 'transport', ...at, action: 'play' });
        else if (event.command === 'continue') controls.push({ type: 'transport', ...at, action: 'play' });
        else if (event.command === 'stop') controls.push({ type: 'transport', ...at, action: 'stop' });
        break;
      case 'note': {
        const note = { type: 'note', ...at, cell: event.cell, velocity: event.velocity, duration };
        if (event.note !== undefined) note.note = Math.round(event.note);
        else if (event.n !== undefined) {
          const root = cells[event.cell - 1]?.rootNote;
          if (!Number.isInteger(root)) {
            unsupported.push(`n on cell ${event.cell} is not sent: PAM named no root note for that cell`);
            break;
          }
          note.note = root + event.n;
        }
        notes.push(note);
        break;
      }
      case 'press':
        unsupported.push(
          `press("${event.name}${event.arg ? `:${event.arg}` : ''}") is not sent: PAM's play interface has no event for it` +
            (event.name === 'mute' || event.name === 'solo' ? `. knob("${event.name}", 1) sets it` : ''),
        );
        break;
      case 'preset':
        unsupported.push("progNum is not sent: PAM in the browser loads a preset by name, as in pamsetup({ web: true, preset: 'name' })");
        break;
      case 'cc':
        unsupported.push('ccn/ccv is not sent: PAM in the browser has no MIDI mappings. knob(id, value) sets a parameter');
        break;
      case 'nrpn':
        unsupported.push('nrpnn/nrpv is not sent: PAM in the browser has no MIDI mappings. knob(id, value) sets a parameter');
        break;
    }
  }
  return { events: [...first, ...controls, ...notes], unsupported };
}

const listed = (cells) => (cells.length ? cells.join(', ') : 'none');

function saysRoot(roots, cell) {
  if (roots === undefined || roots === null) return false;
  if (Array.isArray(roots)) return roots[cell - 1] !== undefined;
  if (typeof roots === 'object') return roots[cell] !== undefined;
  return true;
}

/**
 * Where a setup and the PAM that answered disagree. The setup describes a PAM for the MIDI output,
 * and PAM in the browser says what it has: its word is the one that is used.
 *
 * @param {{ cells?: { cell: number, armed: boolean, pitched: boolean, rootNote: number }[] }} welcome
 * @param {import('./midimap.mjs').PamSetup} setup
 * @param {{ names?: object, poly?: unknown, roots?: unknown }} [said] the options the setup was made from
 * @returns {string[]} one sentence for each disagreement
 */
export function checkSetup(welcome, setup, said = {}) {
  const cells = welcome?.cells ?? [];
  const out = [];
  for (const [name, cell] of Object.entries(said.names ?? {})) {
    const pams = cells[cell - 1];
    if (!pams) out.push(`names: "${name}" is cell ${cell}, and this PAM has ${cells.length} cells`);
    else if (pams.armed === false) out.push(`names: "${name}" is cell ${cell}, which is not armed in this PAM, so it takes no notes`);
  }
  if (said.poly !== undefined) {
    const mine = setup.cells.flatMap((cell, i) => (cell.poly && i < cells.length ? [i + 1] : []));
    const pams = cells.filter((cell) => cell.pitched).map((cell) => cell.cell);
    if (mine.join() !== pams.join()) {
      out.push(`poly: the setup says that cells ${listed(mine)} play by pitch, and in this PAM cells ${listed(pams)} do. PAM's own are what plays`);
    }
  }
  for (const pams of cells) {
    const mine = setup.cells[pams.cell - 1]?.root;
    if (pams.pitched && saysRoot(said.roots, pams.cell) && mine !== pams.rootNote) {
      out.push(`roots: cell ${pams.cell}'s root is ${mine} in the setup and ${pams.rootNote} in this PAM. n() counts from PAM's`);
    }
  }
  return out;
}

function subject(event) {
  switch (event?.type) {
    case 'note':
      return `a note on cell ${event.cell}`;
    case 'param':
      return event.paramId;
    case 'variation':
      return `variation ${event.index + 1}`;
    case 'mute':
    case 'solo':
      return `${event.type} on cell ${event.cell}`;
    case 'transport':
      return `transport ${event.action}`;
    default:
      return 'an event';
  }
}

const noCounts = () => ({ sent: 0, accepted: 0, refused: {}, tooLate: 0 });


// Whether a document's `open` takes the three-argument form, which opens a window. A browser that
// lacked it would read the call as the other form and clear the page. A document with no window
// refuses the three-argument form (InvalidAccessError, in Chromium, WebKit and Gecko alike) and
// takes the other, so a throwaway one tells the two apart without opening anything.
function opensWindows(document) {
  if (typeof document?.open !== 'function' || typeof document.implementation?.createHTMLDocument !== 'function') return false;
  try {
    document.implementation.createHTMLDocument('').open('about:blank', '_blank', '');
    return false;
  } catch (err) {
    return err?.name === 'InvalidAccessError';
  }
}

/**
 * Makes the connection to one PAM. It reaches for nothing until `connect` is called.
 *
 * States: `idle`, `checking` (reading this page's own headers), `opening` (PAM's tab is loading),
 * `pairing` (finding PAM under a code), `waiting` (for the person at the PAM tab to choose Allow),
 * `connected`, and where it ended otherwise: `denied`, `unsupported`, `refused`, `unpaired`,
 * `unavailable`, `disconnected`, `closed`.
 *
 * @param {object} [options]
 * @param {object} [options.env] where `window`, `document`, `location`, `performance`,
 *   `crossOriginIsolated`, `RTCPeerConnection`, `fetch` and `crypto` are looked up (default `globalThis`)
 * @param {string} [options.name] what this sender is called in PAM's question to its user
 * @param {(text: string, type?: string) => void} [options.report] takes each problem, once
 * @param {(text: string) => void} [options.log] takes news that is not a problem
 * @param {() => void} [options.onCells] called when PAM says which cells it has now
 * @param {(event: object, code: string) => void} [options.onRefused] called with each event that PAM refused, and why
 */
export function createPlayClient({ env = globalThis, name = 'mapuzu', report = () => {}, log = () => {}, onCells = () => {}, onRefused = () => {} } = {}) {
  let port; // the way to PAM that is in use
  let key; // which PAM it leads to: PAM's site, and the code if one was given
  let origin;
  let page;
  let room; // the code of the pairing, when there is one
  let link; // PAM's page under this page's own code, to open by hand where the browser will not
  let ownRoom; // the code this page made: a channel that closed is paired again under it
  let openedFor; // the code that PAM's tab was last opened for
  let stop; // stops the pairing that is under way, when it is no longer the one wanted
  let cut = false; // a tab that this page opened went out of reach, so no window leads to PAM from here
  // What this page's own headers say about being kept apart. They are asked for once, by the
  // first setup that has a tab to open, and `then` is whoever waits for the answer.
  const policy = { asked: false, settled: false, apart: undefined, then: undefined };
  let wanted; // the preset asked for
  let state = 'idle';
  let welcome;
  let leadMs = 0;
  let measured = false; // whether `leadMs` is from an answer to `events`, and not from the welcome
  let shiftMs = 0;
  let enoughMs = 0;
  let clockMs = 0; // how far PAM's clock is ahead of this page's
  let rereading = false; // whether that is being measured again, after events came back as far from their time
  let transitMs = 0; // the longest that a message has taken to reach PAM and be read, since the last `connect`
  let aheadMs; // the least look-ahead that events have come with since the last `connect`, to the millisecond
  let leastAhead = Infinity; // and as it was measured
  let audio;
  let engine;
  let next = 1;
  let connecting; // the resolver of the `connect` that is waiting
  let listening = false;
  let counts = noCounts();
  const waiting = new Map(); // request id -> what to do with its answer
  const told = new Set();

  const now = () => env.performance.timeOrigin + env.performance.now();

  function tell(id, text, type) {
    if (told.has(id)) return;
    told.add(id);
    report(text, type);
  }

  function status() {
    return {
      state,
      page,
      ...(port ? { via: port.via } : {}),
      ...(room ? { room } : {}),
      ...(link ? { link } : {}),
      ...(welcome ? { welcome } : {}),
      leadMs,
      shiftMs,
      ...(clockMs ? { clockMs } : {}),
      ...(aheadMs === undefined ? {} : { aheadMs }),
      ...(transitMs ? { transitMs } : {}),
      ...counts,
      refused: { ...counts.refused },
      ...(counts.tooLate ? { enoughMs } : {}),
      ...(audio ? { audio } : {}),
      ...(engine ? { engine } : {}),
    };
  }

  function settle() {
    const resolve = connecting;
    connecting = undefined;
    resolve?.(status());
  }

  function request(kind, fields = {}, onAnswer = () => {}) {
    const id = next++;
    waiting.set(id, onAnswer);
    try {
      port.post({ channel: PLAY_CHANNEL, kind, id, ...fields });
    } catch {
      waiting.delete(id);
    }
    return id;
  }

  function lost(to, text) {
    state = to;
    waiting.clear();
    report(text, 'error');
    settle();
  }

  const gone = () => (port.via === 'tab' ? 'the PAM tab is closed: evaluate again to open it' : 'the way to PAM has closed: its tab was closed or loaded again. Evaluate again to reach it again');

  // A window says nothing when it closes, so `closed` is read before each send. A channel does say.
  function take(taken) {
    port = taken;
    taken.onmessage = receive;
    taken.onclose = () => port === taken && (state === 'connected' || state === 'waiting') && lost('closed', gone());
  }

  const tabPort = (tab, to = origin) => ({
    via: 'tab',
    window: tab,
    post: (message) => tab.postMessage(message, to),
    get closed() {
      return tab.closed;
    },
    close() {},
  });

  // Every window's messages arrive here, and only those of PAM's tab, from PAM's origin and on
  // the interface's channel, are heard.
  function onWindowMessage(event) {
    const data = event.data;
    if (event.origin !== origin || data?.channel !== PLAY_CHANNEL || port?.window !== event.source) return;
    receive(data);
  }

  function receive(data) {
    if (data.kind === 'ack') {
      const answer = waiting.get(data.id);
      waiting.delete(data.id);
      answer?.(data);
    } else if (data.kind === 'ready') onReady();
    else if (data.kind === 'status') onStatus(data);
    else if (data.kind === 'preset' && welcome) {
      welcome = { ...welcome, preset: data.preset, cells: data.cells ?? welcome.cells };
      onCells();
    }
  }

  // PAM says `ready` when its page has loaded. A PAM that says it to a sender it had welcomed has
  // been loaded again, and has forgotten the sender.
  function onReady() {
    if (state === 'opening' || state === 'waiting') sayHello();
    else if (state === 'connected') lost('disconnected', 'the PAM tab was loaded again, so PAM no longer knows this page: evaluate again to reconnect');
  }

  function onStatus(data) {
    if (data.audio) audio = data.audio;
    if (data.engine) engine = data.engine;
    if (data.audio === 'blocked') tell('audio', `PAM cannot make sound yet: ${HINTS['audio-blocked']}`);
    if (data.engine === 'stopped') tell('engine', "PAM's audio engine has stopped: look at the PAM tab");
    if (data.connected === false && (state === 'connected' || state === 'waiting')) {
      lost('disconnected', `PAM disconnected this page${data.reason ? ` (${data.reason})` : ''}: evaluate again to reconnect`);
    }
  }

  function sayHello() {
    state = 'waiting';
    request('hello', { protocol: PLAY_PROTOCOL, name }, (ack) => {
      if (ack.ok) return welcomed(ack.result);
      const { code, message, protocol } = ack.error ?? {};
      if (state === 'connected') return undefined;
      if (code === 'access_denied') return lost('denied', 'Deny was chosen in the PAM tab, and PAM keeps that answer until its tab is closed: close it and evaluate again to be asked again');
      if (code === 'unsupported_version') {
        return lost('unsupported', `this PAM speaks version ${JSON.stringify(protocol)} of the play interface, and this mapuzu speaks version ${PLAY_PROTOCOL}: update whichever is older`);
      }
      return lost('refused', `PAM refused the connection (${code})${message ? `: ${message}` : ''}`);
    });
  }

  function welcomed(result) {
    // A page that sets up again is welcomed with what it holds, and what PAM said since then stands.
    const first = state !== 'connected';
    welcome = result;
    state = 'connected';
    if (first) {
      leadMs = Number(result.timing?.leadMs) || 0;
      log(`[pam] playing PAM ${result.version ?? ''} at ${origin}: preset ${result.preset}, ${leadMs} ms of lead`);
    }
    // The clocks are compared at every setup: the computer may have slept since the last one.
    return readClock(3, undefined, loadWanted);
  }

  // Every time that is sent is on PAM's clock. The two pages count time from when each was loaded,
  // and they disagree when the computer's clock moved or the computer slept in between. PAM says
  // when a request reached it (`received`), and this page knows when it asked (t0) and when it
  // heard (t2): the offset is received - (t0 + t2) / 2, from the shortest of three round trips.
  function readClock(left, best, then) {
    const t0 = now();
    request('getTransport', {}, (ack) => {
      const t2 = now();
      const received = Number(ack.result?.received);
      const reading = { trip: t2 - t0, offset: received - (t0 + t2) / 2 };
      const kept = ack.ok && Number.isFinite(received) && !(best?.trip <= reading.trip) ? reading : best;
      if (ack.ok && left > 1) return readClock(left - 1, kept, then);
      const was = clockMs;
      // A reading can be out by half its round trip, so a difference inside that is no difference.
      clockMs = kept && Math.abs(kept.offset) > kept.trip / 2 + 1 ? Math.round(kept.offset) : 0;
      if (clockMs && clockMs !== was) log(`[pam] PAM's clock reads ${Math.abs(clockMs)} ms ${clockMs > 0 ? 'ahead of' : 'behind'} this page's: every time is sent as PAM reads it`);
      return then();
    });
  }

  // Events that PAM calls hours late or far ahead were not sent too late: the clocks have come
  // apart since they were compared, as they do when the computer sleeps. They are compared again.
  function rereadClock() {
    tell('clock', "PAM refused events as far from their time, which means that the two pages' clocks have come apart since they were compared, as they do when the computer sleeps. They are being compared again");
    if (rereading || state !== 'connected') return;
    rereading = true;
    readClock(3, undefined, () => (rereading = false));
  }

  function loadWanted() {
    if (!wanted || welcome.preset === wanted) return settle();
    if (Array.isArray(welcome.presets) && !welcome.presets.includes(wanted)) {
      const some = welcome.presets.slice(0, 12).join(', ');
      report(`this PAM has no preset "${wanted}". It has: ${some}${welcome.presets.length > 12 ? ', ...' : ''}`, 'error');
      return settle();
    }
    return request('loadPreset', { slug: wanted }, (ack) => {
      if (ack.ok) {
        welcome = { ...welcome, preset: ack.result?.preset ?? wanted, cells: ack.result?.cells ?? welcome.cells };
        onCells();
      } else report(`PAM did not load the preset "${wanted}" (${ack.error?.code})${ack.error?.message ? `: ${ack.error.message}` : ''}`, 'error');
      settle();
    });
  }

  // A tab of this name may be PAM, left open by this page before it was loaded again. Opening the
  // name with no address finds that tab without loading it again, or makes an empty one to send to PAM.
  function openTab() {
    const tab = openWindow('', PLAY_WINDOW);
    // A tab that the browser will not open is opened by hand, and a page reaches that one under a code.
    if (!tab) return pairOwn(policy.apart);
    take(tabPort(tab));
    state = 'opening';
    let empty;
    try {
      empty = tab.location.href === 'about:blank';
    } catch {
      empty = false;
    }
    const address = wanted ? withPreset(page, wanted) : page;
    if (empty) {
      tab.location.href = address;
      return log(`[pam] opening PAM at ${address}: choose Allow in its tab`);
    }
    // A tab that was open said `ready` long ago. PAM answers a `ping` at once, from any page and
    // before any question. A tab that does not answer has gone somewhere else, and is sent to PAM.
    const mine = port;
    const here = () => port === mine && state === 'opening';
    const silent = setTimeout(() => {
      if (!here()) return;
      waiting.delete(asked);
      tab.location.href = address;
      log(`[pam] the tab that was open is not PAM's any more: opening PAM at ${address} in it`);
    }, PING_WAIT_MS);
    const asked = request('ping', {}, () => {
      clearTimeout(silent);
      if (here()) sayHello();
    });
    return undefined;
  }

  function unpaired(err, code, given) {
    if (err.code === 'no_webrtc') return 'this browser has no WebRTC, which is how this page would reach a PAM tab';
    if (err.code === 'no_addresses') return 'the browser did not finish preparing a connection within 5 seconds: it found no network address to give PAM. Check that this browser is allowed to use WebRTC';
    if (err.code === 'too_large') return `${err.message}, so it cannot be handed over. It lists every network address of this computer, and a computer with many network adapters or VPNs lists more than PAM's site takes`;
    if (err.code === 'busy') return `${err.message}, longer than the pairing can wait: evaluate again in a moment`;
    if (err.code === 'pairing_off') return `${origin} does not pair tabs, so no PAM can be reached there from this page. Name the site that serves PAM: pamsetup({ web: 'https://map.audio' })`;
    if (err.code === 'signalling') return `PAM's site did not take the pairing (${err.message}): ${origin} may be out of reach, or not a site that serves PAM`;
    if (err.code === 'no_answer' && given) return `no PAM answered under the code ${code} within 15 seconds: the PAM page that gave it was closed, or has stopped listening. Get a new line from PAM's page`;
    if (err.code === 'no_answer') return `no PAM answered within 2 minutes. Open this address in this browser, then evaluate again: ${link}`;
    return "PAM answered, but the browser or the network did not let the two tabs connect directly, and they talk straight to each other over this computer's own network, with no relay. On a Mac, the browser needs Local Network access (System Settings > Privacy & Security > Local Network). A firewall, a VPN, a privacy extension or a browser setting that blocks local WebRTC or multicast also stops it";
  }

  // Finds PAM under a code and joins it by a data channel. A code that PAM's page gave has a PAM
  // listening under it. Under this page's own code PAM's page has to be opened, and a browser that
  // will not open it is not an error: the address is shown, to be opened by hand. The tab is
  // opened before the offer is left, while the key press that started this still counts.
  function pairUnder(code, given) {
    stop?.abort();
    const mine = new AbortController();
    stop = mine;
    state = 'pairing';
    room = code;
    link = undefined;
    let open = () => {};
    if (!given) {
      const address = new URL(wanted ? withPreset(page, wanted) : page);
      address.hash = `room=${code}`;
      link = address.href;
      open = () => {
        const tab = openWindow(link, PLAY_WINDOW);
        if (tab) log(`[pam] opening PAM at ${link}: choose Allow in its tab`);
        else tell('link', `the browser did not open PAM's tab. Open this address yourself, in this browser, and PAM pairs with this page: ${link}`);
      };
    }
    // A PAM tab that was opened for this code may still be there, loaded again: it is given a moment to answer.
    const first = !given && openedFor !== code;
    if (first) {
      openedFor = code;
      open();
    }
    pair({
      env,
      label: PLAY_CHANNEL,
      room: code,
      signalling: createSignalling({ origin, fetch: env.fetch ?? globalThis.fetch }),
      answerWaitMs: given ? ANSWER_WAIT_MS.given : ANSWER_WAIT_MS.own,
      signal: mine.signal,
      ...(given || first ? {} : { slowAfterMs: OPEN_AGAIN_MS, onSlow: open }),
    }).then(
      (channel) => {
        if (mine.signal.aborted) return channel.close();
        take(channel);
        return sayHello();
      },
      (err) => (mine.signal.aborted ? undefined : lost('unpaired', unpaired(err, code, given))),
    );
  }

  // No tab that this page opens leads to PAM from a page that the browser keeps apart from tabs
  // of other sites: the tab would open, and nothing would cross. Such a page pairs under a code.
  // A code works from every page, so a page pairs under one unless it is known not to be kept
  // apart: a tab is opened for `postMessage` only then.
  function own() {
    if (env.crossOriginIsolated === true || cut) return pairOwn(true);
    if (policy.settled) return policy.apart === false ? openTab() : pairOwn(policy.apart);
    state = 'checking';
    // The answer or the end of the wait decides, whichever is first, and inside its own callback:
    // that is where a browser still counts the key press. It decides for whatever setup is waiting
    // by then, and for none if the wait was given up.
    const decide = () => {
      clearTimeout(waited);
      if (state !== 'checking') return undefined;
      return policy.apart === false ? openTab() : pairOwn(policy.apart);
    };
    policy.then = decide;
    const waited = setTimeout(decide, POLICY_WAIT_MS);
    if (policy.asked) return undefined;
    policy.asked = true;
    return askOpenerPolicy(env, (apart) => {
      Object.assign(policy, { settled: true, apart });
      policy.then?.();
    });
  }

  function pairOwn(known) {
    if (known === undefined) log('[pam] it is not known whether this page can talk to a tab of another site, so it pairs with PAM under a code, which works either way');
    else if (!cut) log('[pam] this page is kept apart from tabs of other sites (by its Cross-Origin-Opener-Policy), so it pairs with PAM under a code and talks to it directly');
    ownRoom ??= makeRoom(env.crypto ?? globalThis.crypto);
    return pairUnder(ownRoom, false);
  }

  // A code from PAM's page needs no tab to be opened, only WebRTC and PAM's site, which the pairing checks.
  function find(where) {
    if (!listening && typeof env.window?.addEventListener === 'function') {
      listening = true;
      env.window.addEventListener('message', onWindowMessage);
      env.window.addEventListener('pagehide', bye);
    }
    if (where.room) return pairUnder(where.room, true);
    if (!env.window) return lost('unavailable', 'the web output needs a browser: there is no window here to open PAM in');
    return own();
  }

  // Opens a tab, or finds the one of that name, as `window.open` does, and gives null where the
  // browser will not. A page that runs Strudel has something of Strudel's as its global `open`,
  // a pattern today. What that gives is no window, and there the three-argument `document.open`
  // is used: HTML defines it as the window's `open`.
  function openWindow(address, name) {
    try {
      const opened = typeof env.window?.open === 'function' ? env.window.open(address, name) : undefined;
      if (opened === null || typeof opened?.postMessage === 'function') return opened;
      // Exactly three arguments: with fewer, `document.open` clears this page for writing.
      if (opensWindows(env.document)) return env.document.open(address, name, '');
    } catch {
      // The browser refused.
    }
    return null;
  }

  function drop() {
    if (state === 'connected' && port && !port.closed) request('bye');
    port?.close();
    port = undefined;
    stop?.abort();
    stop = undefined;
    waiting.clear();
    welcome = undefined;
    counts = noCounts();
    enoughMs = 0;
    clockMs = 0;
    rereading = false;
    measured = false;
    room = undefined;
    link = undefined;
    startOver();
  }

  // What the events of a run showed: how little look-ahead they came with, how long they took to
  // reach PAM, and the shift that those two asked for. A run is from one start of the scheduler
  // to its stop. An evaluation in the middle of a run keeps them, so that nothing moves under it.
  function startOver() {
    shiftMs = 0;
    aheadMs = undefined;
    leastAhead = Infinity;
    transitMs = 0;
  }

  /**
   * Finds or opens PAM and asks to play it. Call it from a key press or a click: a browser opens a
   * tab for nothing else. The answer waits for the person at the PAM tab.
   *
   * A PAM that is still reachable is used again. One whose way has closed is reached again as it
   * was reached before, a pairing under the same code.
   *
   * @param {{ page: string, origin: string, room?: string, preset?: string }} where from `playTarget`
   * @returns {Promise<object>} `status()`, once PAM has answered or cannot be reached. A call
   *   that a later call overtakes never resolves, so that only the newest goes on
   */
  function connect(where) {
    wanted = where.preset;
    told.clear();
    const to = `${where.origin} ${where.room ?? ''}`;
    const same = Boolean(port) && !port.closed && to === key;
    const underWay = state === 'pairing' && to === key;
    // Not every browser says that a page is kept apart. There the tab is opened, and reads as closed once PAM has loaded in it.
    if (port?.via === 'tab' && port.closed && (state === 'opening' || state === 'waiting')) {
      cut = true;
      report('the PAM tab that this page opened went out of reach before PAM answered. Unless you closed it, the browser keeps this page apart from tabs of other sites, so from now on this page pairs with PAM under a code instead');
    }
    if (!same && !underWay) drop();
    ({ page, origin } = where);
    key = to;
    return new Promise((resolve) => {
      connecting = resolve;
      // A pairing that is under way goes on, and its end resolves this call.
      if (underWay) return undefined;
      if (same && state === 'connected') return welcomed(welcome);
      if (same) return sayHello();
      return find(where);
    });
  }

  // `sentAt` is on PAM's clock, as the times of the events that were sent are.
  function onEventsAnswer(ack, sent, sentAt) {
    if (!ack.ok) {
      const { code, message } = ack.error ?? {};
      counts.refused[code] = (counts.refused[code] ?? 0) + sent.length;
      sent.forEach((event) => onRefused(event, code));
      if (code === 'not_connected') return lost('disconnected', 'PAM no longer takes events from this page: evaluate again to reconnect');
      return tell(`message:${code}`, `PAM refused ${sent.length} events at once (${code})${message ? `: ${message}` : ''}${HINTS[code] ? `. ${HINTS[code]}` : ''}`);
    }
    const { accepted = 0, refused = [] } = ack.result ?? {};
    if (Number.isFinite(ack.result?.leadMs)) {
      // The lead belongs to the output device. When it changes, as with a headset that is taken
      // off, what refusals taught under the old one no longer holds.
      if (measured && Math.abs(ack.result.leadMs - leadMs) > LEAD_STEP_MS) enoughMs = 0;
      leadMs = ack.result.leadMs;
      measured = true;
    }
    // Beyond PAM's look-ahead a time is not early or late: it is on another clock.
    const far = Number(welcome?.limits?.lookaheadMs) || 2000;
    // `received` is PAM's clock when it read the message, so this is how long the message took.
    const transit = Number(ack.result?.received) - sentAt;
    if (transit > 0 && transit <= far) transitMs = Math.max(transitMs, Math.ceil(transit));
    counts.accepted += accepted;
    for (const refusal of refused) {
      const event = sent[refusal.index];
      counts.refused[refusal.code] = (counts.refused[refusal.code] ?? 0) + 1;
      onRefused(event, refusal.code);
      if (refusal.code === 'too_far_ahead' || (refusal.code === 'too_late' && refusal.lateByMs > far)) rereadClock();
      else if (refusal.code === 'too_late') {
        counts.tooLate++;
        // What the event had, and by how much PAM says that fell short.
        enoughMs = Math.max(enoughMs, Math.ceil((event?.time ?? sentAt) - sentAt + (Number(refusal.lateByMs) || 0)));
        tell('too_late', 'PAM refused events that reached it too late, and did not play them. pamstatus().web.enoughMs is the look-ahead that would have been enough');
      } else {
        const what = subject(event);
        const hint = HINTS[refusal.code];
        tell(`${refusal.code}:${what}`, `PAM refused ${what} (${refusal.code})${refusal.message ? `: ${refusal.message}` : ''}${hint ? `. ${hint}` : ''}`);
      }
    }
    return undefined;
  }

  /**
   * Sends events. Every time is moved later by `shiftMs`, which grows when the events come with
   * less look-ahead than PAM needs: PAM refuses an event that is late and never plays it late.
   * Every time is also put on PAM's clock, where the two pages' clocks differ (`clockMs`).
   *
   * @param {object[]} events from `toPlayEvents`, in the order PAM should take them
   * @returns {boolean} false when there is no PAM to send to
   */
  function send(events) {
    if (state !== 'connected') return false;
    if (port.closed) {
      lost('closed', gone());
      return false;
    }
    if (!events.length) return true;
    const sentAt = now();
    const earliest = Math.min(...events.map((event) => event.time ?? Infinity));
    if (Number.isFinite(earliest)) {
      leastAhead = Math.min(leastAhead, earliest - sentAt);
      aheadMs = Math.round(leastAhead);
    }
    // PAM's lead and the time a message takes to reach it, or what a refusal showed would have been enough.
    const lead = measured ? leadMs : Math.max(leadMs, UNMEASURED_LEAD_MS);
    const need = Math.max(lead + Math.max(MARGIN_MS, transitMs), enoughMs + MARGIN_MS);
    // The shift is what the least look-ahead falls short of the need by. It goes up at once. It
    // comes down when the need has dropped by more than a little, as when PAM's lead does.
    const short = Number.isFinite(leastAhead) ? Math.max(0, Math.ceil((need - leastAhead) / 10) * 10) : shiftMs;
    if (short > shiftMs || short <= shiftMs - LEAD_STEP_MS) {
      if (!short) tell('shift:0', `this PAM needs ${Math.round(need)} ms now, and events reach it ${aheadMs} ms before their time: nothing is moved later any more`);
      shiftMs = short;
    }
    if (shiftMs) {
      tell(
        `shift:${shiftMs}`,
        `events reach PAM ${aheadMs} ms before their time, and this PAM needs ${Math.round(need)} ms: everything now plays ${shiftMs} ms later than this page's clock says`,
      );
    }
    const move = shiftMs + clockMs;
    const moved = move ? events.map((event) => (event.time === undefined ? event : { ...event, time: event.time + move })) : events;
    const each = Math.max(1, Number(welcome?.limits?.eventsPerMessage) || 256);
    for (let start = 0; start < moved.length; ) {
      const end = partEnd(moved, start, Math.min(start + each, moved.length));
      post(moved.slice(start, end), sentAt + clockMs);
      start = end;
    }
    return true;
  }

  // Where a message that starts at `start` may end, at `end` or before. What follows a variation
  // switch for the same time rides the switch only in the same message, so no message ends
  // between them, unless they are more than one message holds.
  function partEnd(events, start, end) {
    const time = events[end]?.time;
    if (time === undefined || events[end].type === 'variation') return end;
    for (let i = end - 1; i > start && events[i].time === time; i--) if (events[i].type === 'variation') return i;
    return end;
  }

  // One `events` message, or two parts of it where it would be longer than the way to PAM carries.
  function post(part, sentAt) {
    if (part.length > 1 && port.maxBytes && byteLength(JSON.stringify({ channel: PLAY_CHANNEL, kind: 'events', id: next, events: part })) > port.maxBytes) {
      const half = partEnd(part, 0, Math.ceil(part.length / 2));
      post(part.slice(0, half), sentAt);
      post(part.slice(half), sentAt);
      return;
    }
    request('events', { events: part }, (ack) => onEventsAnswer(ack, part, sentAt));
    counts.sent += part.length;
  }

  /**
   * Releases every sounding note, and drops the parameter, variation and transport events that are
   * waiting in PAM. A note that PAM has been handed and has not started still plays: version 1
   * cannot take it back.
   */
  function flush() {
    if (state === 'connected' && !port.closed) request('flush');
    startOver();
  }

  /**
   * Ends the session, or gives up reaching PAM if that was still under way. The way to PAM stays
   * open, and a later `connect` asks again over it.
   */
  function bye() {
    if (state === 'connected' && port && !port.closed) request('bye');
    if (['connected', 'checking', 'pairing', 'opening', 'waiting'].includes(state)) state = 'idle';
    stop?.abort();
    waiting.clear();
  }

  return {
    connect,
    send,
    flush,
    bye,
    status,
    get connected() {
      return state === 'connected';
    },
    get shiftMs() {
      return shiftMs;
    },
    get welcome() {
      return welcome;
    },
  };
}
