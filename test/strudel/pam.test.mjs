/*
pam.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The Strudel side against a MIDI output that only records. Nothing here opens a MIDI port: haps
// are fired the way the scheduler fires them, through the trigger `.pam()` attaches.

import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as strudelCore from '@strudel/core';
import { note, s, n, sine, sequence, stack, progNum, Pattern } from '@strudel/core';
import { mini, miniAllStrings } from '@strudel/mini';
import { cell, variation, vari, press, knob, pam, pamsetup, pamstatus, pamhush, pamclock, packageName } from '../../index.mjs';
import { knobKey } from '../../src/strudel/controls.mjs';
import { binding } from '../../src/strudel/npm.mjs';
import { createOutput } from '../../src/strudel/output.mjs';

const __resetPamOutput = binding.reset;
import { paramNumber } from '../../src/pam/midimap.mjs';
import { resolveParam } from '../../src/pam/params.mjs';

// Strings are mini-notation here, as they are in the REPL.
miniAllStrings();

function fakeOutput() {
  const sent = [];
  return { name: 'fake', sent, send: (bytes, timestamp) => sent.push({ bytes: [...bytes], timestamp }) };
}

// Fires every onset of `pat` in [begin, end) as the scheduler would: currentTime 0, onset at cycle / cps.
async function play(pat, { begin = 0, end = 1, cps = 1 } = {}) {
  await Promise.resolve();
  const start = globalThis.performance.now();
  for (const hap of pat.queryArc(begin, end)) {
    if (!hap.hasOnset()) continue;
    await hap.context.onTrigger?.(hap, 0, cps, Number(hap.whole.begin) / cps);
  }
  return start;
}

let out;
beforeEach(() => {
  __resetPamOutput();
  out = fakeOutput();
  pamsetup({ output: out });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Web MIDI as the browser gives it: asynchronous, with named outputs.
function stubWebMidi(outputs) {
  __resetPamOutput();
  const requestMIDIAccess = vi.fn(async () => ({ outputs: new Map(outputs.map((o, i) => [String(i), o])) }));
  vi.stubGlobal('navigator', { requestMIDIAccess });
  return requestMIDIAccess;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the package exports its vocabulary and nothing that would crowd pattern scope', async () => {
  const names = Object.keys(await import('../../index.mjs')).sort();
  assert.deepEqual(names, [
    'cell',
    'knob',
    'packageName',
    'pam',
    'pamDefaults',
    'pamTrigger',
    'pamclock',
    'pamhush',
    'pamsetup',
    'pamstatus',
    'pamtheme',
    'press',
    'vari',
    'variation',
  ]);
  assert.equal(packageName, '@mapaudio/mapuzu');
});

test('controls write their key and nothing else', () => {
  const first = (pat) => pat.queryArc(0, 1)[0].value;
  assert.deepEqual(first(cell(3)), { cell: 3 });
  assert.deepEqual(first(note('c2').cell(5)), { note: 'c2', cell: 5 });
  assert.deepEqual(first(variation(2)), { variation: 2 });
  assert.deepEqual(first(vari(2)), { variation: 2 });
  assert.deepEqual(first(press('mute').cell(3)), { press: 'mute', cell: 3 });
  assert.deepEqual(first(s('1').variation(4)), { s: 1, variation: 4 });
});

test('knob keys: a per-cell name waits for the hap cell, a full id stays, a typo throws with a hint', () => {
  assert.equal(knobKey('filterCutoff'), 'cell_filterCutoff');
  assert.equal(knobKey('cell_filterCutoff'), 'cell_filterCutoff');
  assert.equal(knobKey('mute'), 'cell_mute');
  assert.equal(knobKey('volume'), 'cell_volume');
  assert.equal(knobKey('cell3_filterCutoff'), 'cell3_filterCutoff');
  assert.equal(knobKey('macro_filterCutoff'), 'macro_filterCutoff');
  assert.equal(knobKey('crossfade'), 'crossfade');
  assert.equal(knobKey('cell2_solo'), 'cell2_solo');
  assert.throws(() => knobKey('filtercutoff'), /no parameter "filtercutoff"\. Close: filterCutoff/);
  assert.throws(() => knobKey('zzz'), /PAM has no parameter "zzz"$/);
  assert.throws(() => knob('zzz', 1), /PAM has no parameter "zzz"/);
});

test('knob as a function takes its structure from the value, and as a method from the pattern', () => {
  const moves = knob('filterCutoff', sequence(300, 1200, 8000)).cell(3);
  assert.deepEqual(
    moves.queryArc(0, 1).map((h) => [Number(h.whole.begin).toFixed(3), h.value]),
    [
      ['0.000', { cell_filterCutoff: 300, cell: 3 }],
      ['0.333', { cell_filterCutoff: 1200, cell: 3 }],
      ['0.667', { cell_filterCutoff: 8000, cell: 3 }],
    ],
  );
  const locked = note(sequence('c2', 'e2')).cell(5).knob('cmi_p1', sequence(0.1, 0.9));
  assert.deepEqual(
    locked.queryArc(0, 1).map((h) => h.value),
    [
      { note: 'c2', cell: 5, cell_cmi_p1: 0.1 },
      { note: 'e2', cell: 5, cell_cmi_p1: 0.9 },
    ],
  );
});

test('a knob id may itself be a pattern, as every double-quoted string is in the REPL', () => {
  const pat = knob(mini('<filterCutoff delayMix>'), 40).cell(2);
  assert.deepEqual(pat.queryArc(0, 1)[0].value, { cell_filterCutoff: 40, cell: 2 });
  assert.deepEqual(pat.queryArc(1, 2)[0].value, { cell_delayMix: 40, cell: 2 });
});

test('.pam() marks its haps and keeps Strudel silent for them', () => {
  const hap = s('1').pam().queryArc(0, 1)[0];
  assert.deepEqual(hap.context.pam, {});
  assert.equal(hap.context.dominantTrigger, true);
  assert.deepEqual(s('1').pam('IAC Driver Bus 1').queryArc(0, 1)[0].context.pam, { port: 'IAC Driver Bus 1' });
  assert.deepEqual(s('1').pam(mini('IAC Driver Bus 1')).queryArc(0, 1)[0].context.pam, { port: 'IAC Driver Bus 1' });
  assert.deepEqual(s('1').pam({ latency: 0.02 }).queryArc(0, 1)[0].context.pam, { latency: 0.02 });
});

test('pam is also a function, so all(pam) routes every pattern', () => {
  assert.ok(pam(s('1')) instanceof Pattern);
  assert.deepEqual(pam(s('1')).queryArc(0, 1)[0].context.pam, {});
  assert.deepEqual(pam('IAC')(s('1')).queryArc(0, 1)[0].context.pam, { port: 'IAC' });
});

test('with Web MIDI, haps fired before the port opens are dropped and counted, not sent late', async () => {
  const request = stubWebMidi([out]);
  await play(s('1 2').pam());
  assert.equal(out.sent.length, 0);
  assert.equal(pamstatus().dropped, 2);
  await settle();
  assert.equal(out.sent.length, 0, 'opening the port does not flush what was missed');
  await play(s('1').pam());
  assert.equal(out.sent.length, 2);
  assert.equal(request.mock.calls.length, 1, 'MIDI access is asked for once');
});

test('the port is picked by name, exactly or by a part of it, and a missing one lists what is there', async () => {
  const a = { ...fakeOutput(), name: 'IAC Driver Bus 1' };
  const b = { ...fakeOutput(), name: 'PAM Virtual In' };
  stubWebMidi([a, b]);
  await play(s('1').pam('pam virtual'));
  await settle();
  await play(s('1').pam('pam virtual'));
  assert.equal(b.sent.length, 2);
  assert.equal(a.sent.length, 0);
  await play(s('1').pam());
  await settle();
  await play(s('1').pam());
  assert.equal(a.sent.length, 2, 'no name means the first output');
  await play(s('1').pam('Nope'));
  await settle();
  assert.match(pamstatus().problems.join('\n'), /no MIDI output named "Nope"\. Found: 'IAC Driver Bus 1', 'PAM Virtual In'/);
});

test('a drum pattern becomes timed note-ons and note-offs', async () => {
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(1000);
  await play(s('1 2').pam(), { cps: 2 });
  const on = out.sent.filter((m) => (m.bytes[0] & 0xf0) === 0x90);
  const off = out.sent.filter((m) => (m.bytes[0] & 0xf0) === 0x80);
  assert.deepEqual(on.map((m) => m.bytes), [
    [0x90, 48, 114],
    [0x90, 49, 114],
  ]);
  // cps 2: cycle 0.5 is a quarter second in. Each hit lasts 0.25 s less the 10 ms gap.
  assert.deepEqual(on.map((m) => m.timestamp), [1000, 1250]);
  assert.deepEqual(off.map((m) => m.timestamp), [1240, 1490]);
});

test('latency shifts every message, from the setup or from the call', async () => {
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(1000);
  await play(s('1').pam({ latency: 0.5 }));
  assert.equal(out.sent[0].timestamp, 1500);
  out.sent.length = 0;
  pamsetup({ output: out, latency: 0.02 });
  await play(s('1').pam());
  assert.equal(out.sent[0].timestamp, 1020);
});

test('the setup decides channels and names', async () => {
  pamsetup({ output: out, channels: 'cell', poly: [5], roots: { 5: 36 }, names: { bass: 5 } });
  await play(note('c2').s('bass').pam());
  assert.deepEqual(out.sent[0].bytes, [0x94, 36, 114]);
  out.sent.length = 0;
  await play(n(7).cell(5).pam());
  assert.deepEqual(out.sent[0].bytes, [0x94, 43, 114]);
});

test('a knob stream sends NRPNs and skips repeats', async () => {
  await play(knob('filterCutoff', sequence(1000, 1000, 4000)).cell(3).pam());
  const number = paramNumber(resolveParam('cell3_filterCutoff'));
  assert.deepEqual(
    out.sent.map((m) => m.bytes),
    [
      [0xbf, 99, number >> 7],
      [0xbf, 98, number & 127],
      [0xbf, 6, 60],
      [0xbf, 99, number >> 7],
      [0xbf, 98, number & 127],
      [0xbf, 6, 85],
    ],
  );
});

test('a continuous signal on a knob is sampled at the onsets of what it sits on', async () => {
  await play(s('1*4').knob('synth_p1', sine).pam());
  const values = out.sent.filter((m) => m.bytes[1] === 6).map((m) => m.bytes[2]);
  // sine at cycle 0, 0.25, 0.5, 0.75 is 0.5, 1, 0.5, 0: four hits, four different-enough values.
  assert.deepEqual(values, [64, 127, 64, 0]);
});

test('variation goes out ahead of its onset, and press and progNum on it', async () => {
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(1000);
  await play(stack(variation(3), press('looperRecord'), progNum(4)).pam(), { begin: 1, end: 2 });
  const at = Object.fromEntries(out.sent.map((m) => [m.bytes.join(','), m.timestamp]));
  assert.deepEqual(at, { '176,16,2': 1800, '176,17,0': 2000, '192,4': 2000 });
});

test('problems are reported once each and listed by pamstatus', async () => {
  await play(stack(s('piano*4'), note('c2')).pam());
  const { problems } = pamstatus();
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /s "piano" names no cell/);
  assert.match(problems.join('\n'), /a note needs a cell/);
  assert.equal(out.sent.length, 0);
});

test('pamclock is 24 ticks a beat, starts PAM at cycle 0, and pamhush stops it', async () => {
  const clock = pamclock().pam();
  assert.equal(clock.queryArc(0, 1).length, 96);
  assert.equal(pamclock(3).queryArc(0, 1).length, 72);
  await play(clock, { begin: 0, end: 0.25 });
  assert.deepEqual(out.sent[0].bytes, [0xfa]);
  assert.equal(out.sent.filter((m) => m.bytes[0] === 0xf8).length, 24);
  out.sent.length = 0;
  await play(clock, { begin: 1, end: 1.25 });
  assert.equal(out.sent.filter((m) => m.bytes[0] === 0xfa).length, 0, 'only cycle 0 starts');
  const lastTick = Math.max(...out.sent.map((m) => m.timestamp));
  out.sent.length = 0;
  pamhush();
  assert.deepEqual(out.sent, [{ bytes: [0xfc], timestamp: lastTick }], 'Stop follows the last tick already queued');
  pamhush();
  assert.equal(out.sent.length, 1, 'a second hush has no clock left to stop');
});

test('pamhush sends all-notes-off on every channel that got a note, and forgets knob values', async () => {
  pamsetup({ output: out, channels: 'cell' });
  await play(stack(s('2'), s('5'), knob('volume', -6)).pam());
  out.sent.length = 0;
  pamhush();
  assert.deepEqual(out.sent.map((m) => m.bytes).sort(), [
    [0xb1, 123, 0],
    [0xb4, 123, 0],
  ]);
  out.sent.length = 0;
  await play(knob('volume', -6).pam());
  assert.equal(out.sent.length, 3, 'the knob is sent again after a hush');
});

test('pamhush goes out again after a note that is already queued, unless the output can clear it', async () => {
  pamsetup({ output: out, channels: 'cell' });
  // The scheduler sends ahead of time: this note is due half a second from now.
  await play(s('~ 2').pam());
  const due = out.sent.find((m) => m.bytes[0] === 0x91).timestamp;
  out.sent.length = 0;
  pamhush();
  assert.deepEqual(out.sent, [
    { bytes: [0xb1, 123, 0], timestamp: undefined },
    { bytes: [0xb1, 123, 0], timestamp: due },
  ]);

  __resetPamOutput();
  const clearing = { ...fakeOutput(), clear: vi.fn() };
  pamsetup({ output: clearing, channels: 'cell' });
  await play(s('~ 2').pam());
  clearing.sent.length = 0;
  pamhush();
  assert.equal(clearing.clear.mock.calls.length, 1);
  assert.deepEqual(clearing.sent, [{ bytes: [0xb1, 123, 0], timestamp: undefined }]);
});

test('a REPL that only logs its stop, as strudel.cc does, hushes PAM and lets a clock start over', async () => {
  const listeners = {};
  const page = { performance: globalThis.performance, document: { addEventListener: (type, heard) => (listeners[type] = heard) } };
  const bound = Pattern.prototype.pam;
  try {
    const onPage = createOutput(strudelCore, page);
    const port = fakeOutput();
    onPage.pamsetup({ output: port });
    const clock = onPage.pamclock().pam();
    await play(clock, { begin: 0, end: 2 / 96 });
    port.sent.length = 0;
    listeners['strudel.log']({ detail: { message: '[cyclist] start' } });
    assert.equal(port.sent.length, 0, 'only the stop hushes');
    listeners['strudel.log']({ detail: { message: '[cyclist] stop' } });
    assert.deepEqual(port.sent.map((m) => m.bytes), [[0xfc]]);
    port.sent.length = 0;
    // Played on without a clock, then one is added again: tick 108 is sixteenth 18.
    await play(clock, { begin: 1 + 12 / 96, end: 1 + 13 / 96 });
    assert.deepEqual(port.sent.map((m) => m.bytes), [[0xf2, 18, 0], [0xfb], [0xf8]]);
  } finally {
    Pattern.prototype.pam = bound;
  }
});

test('a mute and a variation switch on the same bar agree, whichever the scheduler fires first', async () => {
  pamsetup({ output: out, names: { hh: 3 } });
  await play(knob('mute', 1).cell('hh').pam());
  assert.equal(out.sent.length, 3, 'muted');
  out.sent.length = 0;
  // Bar 1 lifts the mute and switches variation, and PAM unmutes with the switch (measured on a
  // running PAM). The scheduler fires both haps in one tick, here the mute's first.
  const mute = knob('mute', '<1 0>').cell('hh').pam().queryArc(1, 2)[0];
  const vary = variation('<1 2>').pam().queryArc(1, 2)[0];
  mute.context.onTrigger(mute, 0, 1, 1);
  vary.context.onTrigger(vary, 0, 1, 1);
  await settle();
  assert.deepEqual(out.sent.map((m) => m.bytes), [[0xb0, 16, 1]], 'the switch, and no toggle: one would mute the cell again');

  out.sent.length = 0;
  // Bar 2: back to variation 1 with the mute on again. It has to be put back after the switch.
  const muted = knob('mute', '<1 0>').cell('hh').pam().queryArc(2, 3)[0];
  const back = variation('<1 2>').pam().queryArc(2, 3)[0];
  muted.context.onTrigger(muted, 0, 1, 2);
  back.context.onTrigger(back, 0, 1, 2);
  await settle();
  assert.deepEqual(out.sent.map((m) => m.bytes[0] === 0xb0 ? 'variation' : 'mute'), ['variation', 'mute', 'mute', 'mute']);
  assert.ok(out.sent[0].timestamp < out.sent[1].timestamp, 'the switch is sent ahead of the bar, the toggle on it');
});

test('declaring the setup again, as every evaluation of a song does, does not toggle a mute back', async () => {
  const song = async () => {
    pamsetup({ output: out, names: { hh: 3 } });
    await play(knob('mute', 1).cell('hh').pam());
  };
  await song();
  assert.equal(out.sent.length, 3, 'the first evaluation mutes');
  await song();
  await song();
  assert.equal(out.sent.length, 3, 'the next ones find it muted and send nothing');
  pamhush();
  await song();
  assert.equal(out.sent.length, 3, 'a stop and start does not unmute either');
  await play(knob('mute', 0).cell(3).pam());
  assert.equal(out.sent.length, 6);
});

test('pamsetup({ muted, soloed }) says what PAM holds, for cells muted by hand', async () => {
  pamsetup({ output: out, muted: [3], soloed: [] });
  await play(knob('mute', 1).cell(3).pam());
  assert.equal(out.sent.length, 0, 'already muted');
  await play(knob('mute', 0).cell(3).pam());
  assert.equal(out.sent.length, 3, 'unmuting toggles');
  pamsetup({ output: out });
  await play(knob('mute', 0).cell(3).pam());
  assert.equal(out.sent.length, 3, 'a setup that says nothing about mutes changes nothing');
  pamsetup({ output: out, muted: [] });
  await play(knob('mute', 1).cell(4).pam('second port'));
  assert.equal(out.sent.length, 6, 'a port opened later starts from what was said');
});

test('outside the browser, with no output given, the port error is reported once', async () => {
  __resetPamOutput();
  await play(s('1*4').pam());
  await settle();
  assert.match(pamstatus().problems.join('\n'), /no Web MIDI here: pass a MIDI output to pamsetup/);
  assert.equal(pamstatus().dropped, 4);
});

test('awaiting pamsetup opens the port, so the first hap is sent', async () => {
  const request = stubWebMidi([out]);
  const status = await pamsetup();
  assert.deepEqual(status.ports, [{ port: '(first output)', connected: true, name: 'fake' }]);
  await play(s('1 2').pam());
  assert.equal(out.sent.length, 4);
  assert.equal(pamstatus().dropped, 0);
  assert.equal(request.mock.calls.length, 1, 'the pattern uses the port pamsetup opened');
});

test('a port that was not there at the first setup is found at the next one', async () => {
  __resetPamOutput();
  // As in the browser, the map of outputs is live: a port switched on later appears in it.
  const outputs = new Map();
  vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn(async () => ({ outputs })) });
  const first = await pamsetup();
  assert.deepEqual(first.ports, [{ port: '(first output)', connected: false, name: undefined }]);
  assert.match(first.problems.join('\n'), /no MIDI output found/);
  await play(s('1').pam());
  assert.equal(pamstatus().dropped, 1);

  outputs.set('0', out);
  const second = await pamsetup();
  assert.deepEqual(second.ports, [{ port: '(first output)', connected: true, name: 'fake' }]);
  assert.deepEqual(second.problems, []);
  await play(s('1').pam());
  assert.equal(out.sent.length, 2, 'the note and its note-off');
});

test('pamsetup with no MIDI to open resolves, and leaves the error for a note that needs the port', async () => {
  __resetPamOutput();
  const status = await pamsetup({ channels: 'cell' });
  assert.deepEqual(status.ports, []);
  assert.deepEqual(status.problems, []);
});

test('a clock added while playing joins on a sixteenth, with a song position and Continue', async () => {
  const clock = pamclock().pam();
  // Ticks 103 to 109 of the pattern: the first sixteenth among them is tick 108, sixteenth 18.
  await play(clock, { begin: 1 + 7 / 96, end: 1 + 14 / 96 });
  assert.deepEqual(out.sent.map((m) => m.bytes), [[0xf2, 18, 0], [0xfb], [0xf8], [0xf8]]);
  assert.equal(out.sent[0].timestamp, out.sent[2].timestamp, 'the position, Continue and its tick go out together');
  out.sent.length = 0;
  await play(clock, { begin: 2, end: 2 + 2 / 96 });
  assert.deepEqual(out.sent.map((m) => m.bytes), [[0xf8], [0xf8]], 'a running clock is not started again');
  out.sent.length = 0;
  await play(clock, { begin: 200, end: 200 + 1 / 96 });
  assert.deepEqual(out.sent.map((m) => m.bytes), [[0xf8]]);
  pamhush();
  out.sent.length = 0;
  // Sixteenth 3200 * 16 = 51200 is past the 14 bits a song position has.
  await play(clock, { begin: 3200, end: 3200 + 1 / 96 });
  assert.deepEqual(out.sent.map((m) => m.bytes), [[0xfb], [0xf8]]);
  assert.match(pamstatus().problems.join('\n'), /past the last song position MIDI can say/);
});

// PAM's clock output as the browser gives it: an EventSource this test speaks through, the REPL's
// setcps, and a clock that stands still so every hap's time is known.
function stubClockFeed() {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  const setcps = vi.fn();
  vi.stubGlobal('setcps', setcps);
  vi.spyOn(globalThis.performance, 'now').mockReturnValue(5000);
  const unixMs = globalThis.performance.timeOrigin + 5000;
  const say = (over = {}) =>
    sources.at(-1).onmessage({ data: JSON.stringify({ version: 1, epoch: 1, playing: true, ppq: 0, bpm: 120, timeSig: [4, 4], unixMs, ...over }) });
  return { sources, setcps, say };
}
const noteOns = () => out.sent.filter((m) => (m.bytes[0] & 0xf0) === 0x90).map((m) => m.bytes[1]);

test('following PAM reads the pattern from PAM\'s bar and runs the scheduler at PAM\'s tempo', async () => {
  const feed = stubClockFeed();
  const ready = pamsetup({ output: out, follow: true });
  assert.equal(feed.sources[0].url, 'http://127.0.0.1:9836/clock');
  feed.say({ ppq: 400 });
  const status = await ready;
  assert.equal(status.clock.following, true);
  assert.deepEqual(feed.setcps.mock.calls.at(-1), [0.5], '120 BPM in 4/4, a bar to the cycle');

  // Cell 1 answers note 48 + n, so the note says which cycle of the pattern played.
  const pat = s('1*4').n('<0 1 2 3>').pam();
  await play(pat, { begin: 0, end: 1, cps: 0.5 });
  assert.deepEqual(noteOns(), [], 'the hap that finds PAM at bar 100, and those read before it, are not sent');
  assert.equal(pamstatus().astray, 4);
  assert.equal(pamstatus().clock.offset, 100);
  await play(pat, { begin: 1, end: 2, cps: 0.5 });
  assert.deepEqual(noteOns(), [49, 49, 49, 49], 'the scheduler\'s cycle 1 is PAM\'s bar 101: cycle 101 of the pattern');
  assert.equal(pamstatus().clock.errorMs, 0);

  out.sent.length = 0;
  feed.say({ epoch: 2, ppq: 0 }); // PAM went back to the top
  await play(pat, { begin: 2, end: 3, cps: 0.5 });
  assert.deepEqual(noteOns(), []);
  assert.equal(pamstatus().clock.offset, 0, 'four seconds after the top PAM is at bar 2, where the scheduler is');
  await play(pat, { begin: 3, end: 4, cps: 0.5 });
  assert.deepEqual(noteOns(), [51, 51, 51, 51], 'cycle 3 of the pattern in PAM\'s bar 3');

  feed.say({ epoch: 2, ppq: 0, bpm: 90 });
  assert.deepEqual(feed.setcps.mock.calls.at(-1), [0.375], 'a tempo change reaches the scheduler as it is heard');
});

test('pamclock is left out while following PAM, and following stops when told', async () => {
  const feed = stubClockFeed();
  const ready = pamsetup({ output: out, follow: true });
  feed.say();
  await ready;
  await play(pamclock().pam(), { begin: 0, end: 0.25, cps: 0.5 });
  assert.equal(out.sent.length, 0);
  assert.match(pamstatus().problems.join('\n'), /pamclock\(\) is left out while following PAM/);

  await pamsetup({ output: out, follow: true });
  assert.equal(feed.sources.length, 1, 'a song file that sets up again keeps the feed and the position it found');
  await pamsetup({ output: out, follow: false });
  assert.equal(feed.sources[0].closed, true);
  assert.equal(pamstatus().clock, undefined);
  await play(s('1').pam(), { cps: 0.5 });
  assert.deepEqual(noteOns(), [48]);
});

test('a PAM that sends no clock is reported, and the setup still resolves', async () => {
  stubClockFeed();
  vi.useFakeTimers();
  try {
    const ready = pamsetup({ output: out, follow: 'http://127.0.0.1:9999/clock' });
    await vi.advanceTimersByTimeAsync(3000);
    const status = await ready;
    assert.equal(status.clock.following, false);
    assert.match(status.problems.join('\n'), /no clock from PAM at http:\/\/127\.0\.0\.1:9999\/clock/);
  } finally {
    vi.useRealTimers();
  }
});

test('a snapshot this cannot read is reported, not followed', async () => {
  const feed = stubClockFeed();
  pamsetup({ output: out, follow: true });
  feed.say({ version: 2 });
  assert.match(pamstatus().problems.join('\n'), /clock snapshot version 2: this reads version 1/);
  assert.equal(pamstatus().clock.following, false);
});

test('outside a browser there is no feed to follow, and it says so', async () => {
  const status = await pamsetup({ output: out, follow: true });
  assert.match(status.problems.join('\n'), /no EventSource here: following PAM needs a browser/);
  assert.equal(status.clock, undefined);
});

test('double-quoted arguments are read as typed, wherever they sit in the options', async () => {
  // What the REPL hands over for pamsetup({ port: "IAC Driver Bus 1", channels: "cell", latency: "0.02", names: { kick: "3" } }).
  await pamsetup({ output: out, port: mini('IAC Driver Bus 1'), channels: mini('cell'), latency: mini('0.02'), names: { kick: mini('3') } });
  const { setup, ports } = pamstatus();
  assert.deepEqual(setup.cells.map((c) => c.channel), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(setup.names.kick, 3);
  assert.ok(ports.some((p) => p.port === 'IAC Driver Bus 1'), 'the port name came back as its words');
  const start = await play(s('kick').pam());
  assert.deepEqual(out.sent[0].bytes, [0x92, 50, 114]);
  assert.ok(Math.abs(out.sent[0].timestamp - start - 20) < 5, 'the latency was a number');
  assert.equal(pamclock(mini('3')).queryArc(0, 1).length, 72);
});
