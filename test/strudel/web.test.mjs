/*
web.test.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The web output against a stand-in for PAM's play page (play-page.mjs). No window is opened, no
// connection is made and no PAM runs: the stand-in answers as PAM's specification says a PAM
// does, and haps are fired the way the scheduler fires them.
//
// What is said to PAM and what PAM answers do not depend on how the messages travel, so those
// tests run once for each way: a PAM tab that the sender opened, and a data channel. After them
// come the tests of each way of reaching PAM.

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as strudelCore from '@strudel/core';
import { Pattern, note, s, n, freq, pure, sequence, stack, progNum, ccn, nrpnn } from '@strudel/core';
import { miniAllStrings } from '@strudel/mini';
import { variation, press, knob } from '../../index.mjs';
import { createOutput } from '../../src/strudel/output.mjs';
import { checkSetup, playTarget, toPlayEvents } from '../../src/pam/play.mjs';
import { PairError, createSignalling, isRoom, makeRoom, pair } from '../../src/pam/play-rtc.mjs';
import { createSetup } from '../../src/pam/midimap.mjs';
import { CHANNEL, PAM_ORIGIN, TIME_ORIGIN, createBrowser, defaultPam } from './play-page.mjs';

miniAllStrings();

const HOME = 'https://map.audio/mapuzu.mjs';
const ROOM = 'Kq3f9xT2mLp8Zc4Vb7Nw1A';
const OTHER_ROOM = 'p0Yd5sR8uJh2Wg6Ee3Ca_-';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let browser;
let out;
let started; // the browser's clock when the scheduler of `run` started
let schedulerClock = 0; // the scheduler's clock at the tick it is in, as Strudel's getClockTime gives it
// The module is loaded: the page gets its output.
const load = () => (out = createOutput({ ...strudelCore, getClockTime: () => schedulerClock }, browser.env, HOME));
beforeEach(() => {
  browser = createBrowser();
  started = undefined;
  schedulerClock = 0;
  load();
});
afterEach(() => {
  browser.close();
  vi.useRealTimers();
  delete Pattern.prototype.onSchedule;
});

// The two schedulers of Strudel. The 1.2.6 on npm, which is installed here, hands every onset
// that a query gives it to `onTrigger(hap, now, cps, time)`. Since Strudel's pull request 2138,
// which strudel.cc runs, a scheduler hands over only what starts inside its tick, to
// `onSchedule(hap, time, cps)`, and the scheduler's clock is `getClockTime()`.
const SCHEDULERS = {
  '1.2.6': () => {},
  'since onSchedule': () => {
    Pattern.prototype.onSchedule = function (schedule, dominant = true) {
      return this.withHap((hap) =>
        hap.setContext({
          ...hap.context,
          onSchedule: (scheduled, time, cps) => {
            hap.context.onSchedule?.(scheduled, time, cps);
            schedule(scheduled, time, cps);
          },
          dominantSchedule: hap.context.dominantSchedule || dominant,
        }),
      );
    };
  },
};
const newer = () => typeof Pattern.prototype.onSchedule === 'function';
// A hap goes to the pattern's own function, as the scheduler of that Strudel hands it over.
function hand(hap, now, cps, time) {
  schedulerClock = now;
  if (newer()) return hap.context.onSchedule(hap, time, cps);
  return hap.context.onTrigger(hap, now, cps, time);
}

// The shared clock at `ms` past the browser's clock: where a hap fired `ms` ahead should be heard.
const at = (ms) => TIME_ORIGIN + browser.clock.ms + ms;

// Fires every onset of `pat` in [begin, end) as one scheduler tick does: all at once, each `ahead`
// seconds before its time. A quarter second is about what Strudel's scheduler gives.
async function play(pat, { begin = 0, end = 1, cps = 1, ahead = 0.25 } = {}) {
  for (const hap of pat.queryArc(begin, end)) {
    if (hap.hasOnset()) hand(hap, 0, cps, Number(hap.whole.begin) / cps + ahead);
  }
  await settle();
}

// Runs `pat` as Strudel's scheduler does, from second `from` of its run and for `seconds`. Every
// 50 ms it asks the pattern for the next 50 ms and fires each onset, a quarter of a second before
// its time, and the browser's clock goes with it. A later call goes on where an earlier one ended,
// which is how an evaluation in the middle of a run looks to the patterns.
const TICK = 0.05;
// `cycle` is where the run is at second `from`, when the tempo has changed there.
async function run(pat, { from = 0, seconds = 1, cps = 1, cycle } = {}) {
  started ??= browser.clock.ms;
  const first = Math.round(from / TICK);
  const begin = (k) => (cycle === undefined ? k * TICK * cps : cycle + (k - first) * TICK * cps);
  const target = (hap) => (cycle === undefined ? Number(hap.whole.begin) / cps : (Number(hap.whole.begin) - cycle) / cps + from) + 0.25;
  for (let k = first; k < first + Math.round(seconds / TICK); k++) {
    browser.clock.ms = started + k * TICK * 1000;
    const end = begin(k) + TICK * cps;
    for (const hap of pat.queryArc(begin(k), end, { _cps: cps, cyclist: 'cyclist' })) {
      // The newer scheduler leaves what starts after its tick for a later tick.
      if (hap.hasOnset() && !(newer() && Number(hap.whole.begin) > end)) hand(hap, k * TICK, cps, target(hap));
    }
    await settle();
  }
}
// The shared clock at second `second` of a run: where what the pattern has there should be heard.
const due = (second) => TIME_ORIGIN + started + second * 1000 + 250;
// The switches that PAM took: the variation, counted from 0, its time, and how long before it PAM had it.
const switched = (pam) => pam.switches.map((taken) => [taken.index, taken.time, Math.round(taken.noticeMs)]);
const riders = (taken) => taken.rode.map((event) => `${event.type} ${event.cell ?? event.paramId} ${event.on ?? event.value}`);

// What the page asked of PAM, without the readings of PAM's clock that follow every welcome.
const requests = (pam) => pam.kinds().filter((kind) => kind !== 'getTransport');
// What the sending page asked of PAM's site: it leaves offers and waits for answers.
const pairingRequests = () => browser.requests.filter(([method, path]) => (method === 'PUT' && /\/offer$/.test(path)) || (method === 'GET' && /\/answer\?/.test(path)));

// How the messages travel: what `pamsetup` is told, and where the PAM is before it is called.
const WAYS = {
  tab: { web: () => true, place: () => {} },
  channel: { web: () => ({ room: ROOM }), place: () => browser.arm(ROOM) },
};

const EVERY_WAY = Object.keys(WAYS).flatMap((way) => Object.keys(SCHEDULERS).map((scheduler) => [way, scheduler]));

describe.each(EVERY_WAY)('what is said to PAM, over a %s, by the scheduler of Strudel %s', (way, scheduler) => {
  const setup = (options = {}) => out.pamsetup({ web: WAYS[way].web(), ...options });
  async function connect(options = {}) {
    const status = await setup(options);
    return { status, pam: browser.pages.at(-1) };
  }
  beforeEach(() => {
    SCHEDULERS[scheduler]();
    WAYS[way].place();
  });

  test('.pam() gives each hap the function that this scheduler calls, and the newer scheduler is not given the one it calls deprecated', () => {
    const [hap] = s('1').pam().queryArc(0, 1);
    assert.deepEqual([typeof hap.context.onSchedule, typeof hap.context.onTrigger], scheduler === '1.2.6' ? ['undefined', 'function'] : ['function', 'undefined']);
  });

  test('PAM is reached, welcomes the page, and its welcome is kept', async () => {
    const { status, pam } = await connect();
    assert.deepEqual([status.web.state, status.web.via], ['connected', way]);
    assert.equal(status.web.leadMs, 40);
    assert.equal(status.web.welcome.preset, 'night-shift');
    assert.equal(status.web.welcome.cells.length, 8);
    assert.deepEqual(status.web.welcome.limits, defaultPam().limits, 'the welcome is kept as PAM sent it');
    assert.deepEqual(status.ports, [], 'no MIDI port is opened');
    assert.deepEqual(status.problems, []);
    assert.deepEqual(pam.messages('hello'), [{ channel: CHANNEL, kind: 'hello', id: pam.messages('hello')[0].id, protocol: 1, name: 'mapuzu' }]);
  });

  test('Deny is reported and nothing is sent, and PAM gives the same answer when asked again', async () => {
    browser.pam.allow = 'no';
    const { status, pam } = await connect();
    assert.equal(status.web.state, 'denied');
    assert.match(status.problems.join('\n'), /Deny was chosen in the PAM tab, and PAM keeps that answer until its tab is closed: close it and evaluate again to be asked again/);
    await play(s('1').pam());
    assert.equal(out.pamstatus().dropped, 1);
    assert.equal(pam.messages('events').length, 0);
    assert.equal((await setup()).web.state, 'denied');
    assert.deepEqual(requests(pam), ['hello', 'hello']);
  });

  test('a PAM that speaks another version of the interface is not played', async () => {
    browser.pam.protocol = 2;
    const { status, pam } = await connect();
    assert.equal(status.web.state, 'unsupported');
    assert.match(status.problems.join('\n'), /this PAM speaks version 2 of the play interface, and this mapuzu speaks version 1: update whichever is older/);
    await play(s('1').pam());
    assert.equal(pam.messages('events').length, 0);
  });

  test('notes go with their exact length and velocity, at their time on the clock the two tabs share, one message to a tick', async () => {
    const { pam } = await connect({ names: { bd: 1, acid: 5 } });
    browser.clock.ms = 5000;
    await play(stack(s('bd*2').velocity(0.5), note('c2 eb2').s('acid').clip(0.5)).pam(), { cps: 2 });
    assert.equal(pam.messages('events').length, 1);
    assert.deepEqual(pam.played, [
      { type: 'note', time: at(250), cell: 1, velocity: 0.5, duration: 250 },
      { type: 'note', time: at(250), cell: 5, velocity: 0.9, duration: 125, note: 36 },
      { type: 'note', time: at(500), cell: 1, velocity: 0.5, duration: 250 },
      { type: 'note', time: at(500), cell: 5, velocity: 0.9, duration: 125, note: 39 },
    ]);
    const status = out.pamstatus();
    assert.deepEqual([status.sent, status.dropped, status.web.sent, status.web.accepted, status.web.shiftMs, status.web.aheadMs], [4, 0, 4, 4, 0, 250]);
    assert.deepEqual(status.problems, []);
  });

  test('n counts from the root that PAM names, a frequency is the nearest note, and a cell with no pitch gets none', async () => {
    const { status, pam } = await connect({ poly: [5], roots: { 5: 48 } });
    assert.match(status.problems.join('\n'), /roots: cell 5's root is 48 in the setup and 36 in this PAM\. n\(\) counts from PAM's/);
    assert.match(status.problems.join('\n'), /poly: the setup says that cells 5 play by pitch, and in this PAM cells 5, 7, 8 do\. PAM's own are what plays/);
    await play(n('0 7').s('5').pam());
    await play(freq(440).s('7').pam());
    await play(s('5 2').pam());
    assert.deepEqual(pam.played.map((event) => [event.cell, event.note]), [[5, 36], [5, 43], [7, 69], [5, undefined], [2, undefined]]);
    assert.ok(!('note' in pam.played[3]), 'a pitched cell with no pitch asked plays its root: the field is left out');
  });

  test('the welcome is compared with the setup: names, poly and roots that PAM does not have are said', async () => {
    const agreeing = await connect({ poly: [5, 7, 8], roots: { 5: 36 }, names: { bd: 1, acid: 5 } });
    assert.deepEqual(agreeing.status.problems, []);
    const unarmed = await setup({ names: { oh: 4 } });
    assert.deepEqual(unarmed.problems, ['names: "oh" is cell 4, which is not armed in this PAM, so it takes no notes']);
  });

  test('a knob goes as the parameter and its exact value, every time, and before the note that carries it', async () => {
    const { pam } = await connect();
    await play(knob('filterCutoff', sequence(1000, 1000, 4000.5)).cell(3).pam());
    assert.deepEqual(pam.played.map((event) => [event.type, event.paramId, event.value]), [
      ['param', 'cell3_filterCutoff', 1000],
      ['param', 'cell3_filterCutoff', 1000],
      ['param', 'cell3_filterCutoff', 4000.5],
    ]);
    assert.equal(pam.played[0].time, at(250));
    pam.played.length = 0;
    await play(stack(s('3').knob('synth_p1', 0.25), knob('macro_filterCutoff', 1234.5), knob('volume', -6), knob('volume', -3).cell(2)).pam());
    assert.deepEqual(pam.played.map((event) => [event.type, event.paramId ?? event.cell, event.value]), [
      ['param', 'cell3_synth_p1', 0.25],
      ['note', 3, undefined],
      ['param', 'macro_filterCutoff', 1234.5],
      ['param', 'volume', -6],
      ['param', 'cell2_volume', -3],
    ]);
  });

  test('a variation is counted from 0 for PAM, and goes before whatever else has its time', async () => {
    const { pam } = await connect({ names: { hh: 3 } });
    await play(stack(knob('delayMix', 30).cell(5), knob('mute', 1).cell('hh'), variation(3)).pam());
    assert.deepEqual(pam.played, [
      { type: 'variation', time: at(250), index: 2 },
      { type: 'param', time: at(250), paramId: 'cell5_delayMix', value: 30 },
      { type: 'mute', time: at(250), cell: 3, on: true },
    ], 'a switch brings back what the variation stores, so what is set for the same time is sent after it');
    await play(variation(8).pam());
    assert.deepEqual(pam.played.slice(3), [{ type: 'mute', time: at(250), cell: 3, on: true }], 'PAM refuses the empty slot, and plays what else came with it');
    assert.match(out.pamstatus().problems.join('\n'), /PAM refused variation 8 \(variation_empty\)/);
  });

  test('a mute or a solo that a pattern asked for goes again behind every variation switch, which would otherwise undo it', async () => {
    const { pam } = await connect({ names: { hh: 3, rim: 6 } });
    const said = () => pam.played.splice(0).map((event) => [event.type, event.cell ?? event.index, event.on]);
    // Bar 0 of a song: its first variation, and the rim muted for the intro. The mute is sent after the switch.
    await play(stack(knob('mute', 1).cell('rim'), variation(4)).pam());
    assert.deepEqual(said(), [['variation', 3, undefined], ['mute', 6, true]]);
    // A later bar switches and sets nothing: what was asked for is held through it.
    await play(stack(variation(1), knob('solo', 1).cell('hh')).pam());
    assert.deepEqual(said(), [['variation', 0, undefined], ['mute', 6, true], ['solo', 3, true]]);
    // A bar that switches and lifts the mute: the held level goes first, and the pattern's own word is the last.
    await play(stack(knob('mute', 0).cell('rim'), variation(2)).pam());
    assert.deepEqual(said(), [['variation', 1, undefined], ['mute', 6, true], ['solo', 3, true], ['mute', 6, false]]);
    await play(variation(3).pam());
    const again = pam.played.splice(0);
    assert.deepEqual(again.map((event) => [event.type, event.cell ?? event.index, event.on]), [['variation', 2, undefined], ['mute', 6, false], ['solo', 3, true]]);
    assert.deepEqual(again.map((event) => event.time), [at(250), at(250), at(250)], 'at the time of the switch');
    assert.deepEqual(out.pamstatus().web.refused, {});
  });

  test('what rides a switch has the very time of the switch and is in its message: a tick is timed against one reading of the clocks', async () => {
    const { pam } = await connect({ names: { hh: 3, rim: 6 } });
    await play(knob('mute', 1).cell('rim').pam());
    pam.played.length = 0;
    // A real clock moves between two readings. Haps of one moment must not get two times from it.
    browser.clock.creep = 0.37;
    await play(stack(knob('delayMix', 30).cell(5), variation(2), knob('mute', 1).cell('hh'), s('1')).pam());
    browser.clock.creep = 0;
    const [first, ...others] = pam.played;
    assert.deepEqual(pam.played.map((event) => event.type), ['variation', 'mute', 'param', 'mute', 'note']);
    for (const event of others) assert.equal(event.time, first.time, `${event.type} has the time of the switch`);
    assert.deepEqual(pam.rode.map((event) => [event.type, event.cell ?? event.paramId]), [['mute', 6], ['param', 'cell5_delayMix'], ['mute', 3]], 'the held mute, the knob and the new mute all ride the switch');
    assert.equal(pam.messages('events').length, 2, 'one message for the tick');
  });

  test('a tick that goes as several messages is not cut between a switch and what rides it', async () => {
    browser.pam.limits.eventsPerMessage = 4;
    const { pam } = await connect({ names: { hh: 3 } });
    // Three notes on the beat, and on the off-beat a switch with a mute: five events, four to a message.
    await play(stack(s('1 ~'), s('2 ~'), s('3 ~'), variation('~ 2'), knob('mute', '~ 1').cell('hh')).pam());
    assert.deepEqual(pam.messages('events').map((message) => message.events.map((event) => event.type)), [['note', 'note', 'note'], ['variation', 'mute']]);
    assert.deepEqual(pam.rode.map((event) => event.type), ['mute']);
  });

  test('more riders than one message holds cannot all ride the switch, and are all still sent', async () => {
    browser.pam.limits.eventsPerMessage = 2;
    const { pam } = await connect();
    await play(stack(variation(3), knob('mute', 1).cell(1), knob('mute', 1).cell(2)).pam());
    assert.deepEqual(pam.messages('events').map((message) => message.events.map((event) => event.type)), [['variation', 'mute'], ['mute']]);
    assert.equal(pam.played.length, 3);
  });

  test('mute and solo go as levels, with no count kept', async () => {
    const { pam } = await connect({ names: { hh: 3 } });
    await play(knob('mute', '<1 0>').cell('hh').pam(), { begin: 0, end: 2, cps: 2 });
    await play(knob('mute', 1).cell('hh').pam());
    await play(knob('mute', 1).cell('hh').pam());
    await play(knob('solo', 1).cell(2).pam());
    assert.deepEqual(pam.played, [
      { type: 'mute', time: at(250), cell: 3, on: true },
      { type: 'mute', time: at(750), cell: 3, on: false },
      { type: 'mute', time: at(250), cell: 3, on: true },
      { type: 'mute', time: at(250), cell: 3, on: true },
      { type: 'solo', time: at(250), cell: 2, on: true },
    ]);
  });

  test("pamclock() runs PAM's transport: started where the pattern is, told again when the tempo changes, stopped by pamhush", async () => {
    const { pam } = await connect();
    const clock = out.pamclock().pam();
    await play(clock, { begin: 0, end: 0.25, cps: 0.55 });
    await play(clock, { begin: 0.25, end: 0.5, cps: 0.55 });
    assert.deepEqual(pam.played, [
      { type: 'transport', time: at(250), action: 'seek', ppqPosition: 0 },
      { type: 'transport', time: at(250), action: 'play', bpm: 132 },
    ], '48 ticks, and no tick is sent');
    pam.played.length = 0;
    await play(clock, { begin: 0.5, end: 0.5 + 1 / 96, cps: 0.5 });
    assert.deepEqual(pam.played, [{ type: 'transport', time: at(1250), action: 'play', bpm: 120 }]);

    pam.received.length = 0;
    pam.played.length = 0;
    out.pamhush();
    await settle();
    assert.deepEqual(pam.kinds(), ['flush', 'events']);
    assert.deepEqual(pam.played, [{ type: 'transport', action: 'stop' }], 'the stop has no time: as soon as PAM can');
    out.pamhush();
    await settle();
    assert.deepEqual(pam.kinds(), ['flush', 'events', 'flush'], 'a second hush has no transport left to stop');

    pam.played.length = 0;
    await play(out.pamclock(3).pam(), { begin: 0.75, end: 0.75 + 1 / 72, cps: 0.5 });
    assert.deepEqual(pam.played, [
      { type: 'transport', time: at(1750), action: 'seek', ppqPosition: 2.25 },
      { type: 'transport', time: at(1750), action: 'play', bpm: 90 },
    ], 'a clock that joins later starts PAM at the position it joins at, three beats to the cycle here');
  });

  test('what the interface has no event for is said once and is not sent as anything else', async () => {
    const { pam } = await connect();
    const unsendable = stack(press('looperRecord'), press('mute').cell(3), progNum(4), ccn(74).ccv(0.5), nrpnn(300).nrpv(0.5));
    await play(unsendable.fast(4).pam());
    assert.equal(pam.messages('events').length, 0);
    const { problems, sent } = out.pamstatus();
    assert.equal(sent, 0);
    assert.deepEqual(problems, [
      "progNum is not sent: PAM in the browser loads a preset by name, as in pamsetup({ web: true, preset: 'name' })",
      'press("looperRecord") is not sent: PAM\'s play interface has no event for it',
      'press("mute") is not sent: PAM\'s play interface has no event for it. knob("mute", 1) sets it',
      'ccn/ccv is not sent: PAM in the browser has no MIDI mappings. knob(id, value) sets a parameter',
      'nrpnn/nrpv is not sent: PAM in the browser has no MIDI mappings. knob(id, value) sets a parameter',
    ]);
  });

  test('events that come with less look-ahead than PAM needs are moved later, all by the same amount, and it is said', async () => {
    const { pam } = await connect();
    await play(s('1').pam());
    assert.equal(out.pamstatus().web.shiftMs, 0, 'a quarter of a second is plenty');
    await play(s('1').pam(), { ahead: 0.02 });
    assert.equal(pam.played[1].time, at(60), 'PAM said it needs 40 ms, and 15 go for the message to cross: 20 short of 55, moved in steps of 10');
    let status = out.pamstatus();
    assert.deepEqual([status.web.shiftMs, status.web.aheadMs, status.web.accepted], [40, 20, 2]);
    assert.match(status.problems.join('\n'), /events reach PAM 20 ms before their time, and this PAM needs 55 ms: everything now plays 40 ms later than this page's clock says/);
    await play(s('1 2').pam(), { cps: 4 });
    assert.deepEqual(pam.played.slice(2).map((event) => event.time), [at(290), at(415)], 'what comes early enough is moved by the same amount, so the spacing holds');
    assert.equal(out.pamstatus().web.aheadMs, 20, 'the least look-ahead seen is what is shown');

    // An evaluation in the middle of a run moves nothing: the shift stays, and it is said again.
    status = await setup();
    assert.deepEqual([status.web.shiftMs, status.web.aheadMs, status.problems], [40, 20, []]);
    await play(s('1').pam());
    assert.equal(pam.played.at(-1).time, at(290));
    assert.match(out.pamstatus().problems.join('\n'), /everything now plays 40 ms later than this page's clock says/);
    // The scheduler stops, and the next run starts from no shift.
    out.pamhush();
    assert.deepEqual([out.pamstatus().web.shiftMs, out.pamstatus().web.aheadMs], [0, undefined]);
    await play(s('1').pam());
    assert.equal(pam.played.at(-1).time, at(250));
  });

  test("the welcome's lead is not planned by: until PAM has answered events, 100 ms is, and then PAM's own figure", async () => {
    // PAM welcomed the page before its audio had started, so it could not know its delays yet.
    browser.pam.welcomeLeadMs = 9;
    browser.pam.leadMs = 75;
    const { status, pam } = await connect();
    assert.equal(status.web.leadMs, 9);
    await play(s('1').pam(), { ahead: 0.05 });
    assert.deepEqual([pam.played.map((event) => event.time), out.pamstatus().web.refused], [[at(120)], {}], "moved by 70 to reach 115: with the welcome's 9 ms it would have gone at 50 and been refused");
    assert.equal(out.pamstatus().web.leadMs, 75, "PAM's answer gives the figure");
    out.pamhush();
    await play(s('1').pam(), { ahead: 0.08 });
    assert.deepEqual([pam.played[1].time, out.pamstatus().web.shiftMs], [at(90), 10], 'from then on the answers are planned by: 75 and 15 make 90');
  });

  test("the shift follows the lead that PAM's answers give: up within two messages when a wireless headset is connected, and down again when it is taken off", async () => {
    const { pam } = await connect();
    browser.pam.leadMs = 75; // the laptop's own output
    const beat = () => play(s('1').pam(), { ahead: 0.2 });
    await beat();
    await beat();
    assert.deepEqual([out.pamstatus().web.leadMs, out.pamstatus().web.shiftMs, pam.played.length], [75, 0, 2]);

    browser.pam.leadMs = 228; // the headset: the sender hears of it from the answer to what it sends next
    await beat();
    let { web } = out.pamstatus();
    assert.deepEqual([web.leadMs, web.refused, pam.played.length], [228, { too_late: 1 }, 2], 'what was on its way with 200 ms of look-ahead is refused');
    await beat();
    ({ web } = out.pamstatus());
    assert.deepEqual([web.shiftMs, web.refused, pam.played.at(-1).time], [50, { too_late: 1 }, at(250)], '228 and 15 make 243, and events come 200 ms ahead: moved by 50, from the very next message');
    assert.match(out.pamstatus().problems.join('\n'), /events reach PAM 200 ms before their time, and this PAM needs 243 ms: everything now plays 50 ms later than this page's clock says/);
    // The lead flutters from answer to answer. The shift goes up at once when it has to, and does not come down for a few milliseconds.
    for (const lead of [229, 236, 229, 228]) {
      browser.pam.leadMs = lead;
      await beat();
    }
    ({ web } = out.pamstatus());
    assert.deepEqual([web.leadMs, web.shiftMs, web.refused, pam.played.length], [228, 60, { too_late: 1 }, 7]);
    assert.deepEqual(pam.played.slice(3).map((event) => event.time), [at(250), at(250), at(260), at(260)], '236 and 15 make 251, which takes 60. 229 would take 50 again, and that is not worth moving everything for');

    browser.pam.leadMs = 75; // the headset is taken off
    await beat();
    assert.deepEqual([out.pamstatus().web.leadMs, out.pamstatus().web.shiftMs], [75, 60], 'the answer to this message is the first to say so');
    await beat();
    ({ web } = out.pamstatus());
    assert.deepEqual([web.shiftMs, web.refused, pam.played.at(-1).time, pam.played.length], [0, { too_late: 1 }, at(200), 9], 'and the next message is back on this page\'s clock');
    assert.match(out.pamstatus().problems.join('\n'), /this PAM needs 90 ms now, and events reach it 200 ms before their time: nothing is moved later any more/);
  });

  test("PAM's transport is started by the shift that its message goes with, and put where the pattern is again whenever the shift changes, so that PAM's bar lines stay with the notes", async () => {
    browser.pam.leadMs = 300; // a wireless headset, from the start
    const { pam } = await connect();
    // A note a second, and the clock: 96 ticks to the cycle, of which none is sent.
    const song = stack(out.pamclock(), s('1*2')).pam();
    // Each start of PAM's transport: the beat it puts PAM on, and how much later than the pattern has that beat.
    const starts = () => pam.played.splice(0).filter((event) => event.type === 'transport').map((event) => (event.action === 'seek' ? [event.ppqPosition, Math.round(event.time - due(event.ppqPosition / 2))] : [event.action, event.bpm]));
    await run(song, { seconds: 1, cps: 0.5 });
    assert.deepEqual([starts(), out.pamstatus().web.shiftMs], [[[0, 70], ['play', 120]], 70], '300 and 15 make 315, and the first message comes 250 ms ahead');

    browser.pam.leadMs = 75; // the headset is taken off
    await run(song, { from: 1, seconds: 1.5, cps: 0.5 });
    // The answer to the note of second 1 says so, and the note of second 2 goes unmoved. The clock tick after it is at beat 4.125.
    assert.deepEqual([starts(), out.pamstatus().web.shiftMs], [[[4.125, 0], ['play', 120]], 0]);

    browser.pam.leadMs = 300; // and put on again
    await run(song, { from: 2.5, seconds: 2, cps: 0.5 });
    // The note of second 3 is refused, and the note of second 4 goes 70 ms later.
    assert.deepEqual([starts(), out.pamstatus().web.shiftMs], [[[8.125, 70], ['play', 120]], 70], 'once for each change, down as well as up');
  });

  test("a start of PAM's transport that PAM refused for a reason that passes is sent again", async () => {
    browser.pam.audio = 'blocked';
    const { pam } = await connect();
    const clock = out.pamclock().pam();
    await play(clock, { begin: 0, end: 0.25, cps: 0.5 });
    assert.deepEqual([pam.played, out.pamstatus().web.refused], [[], { 'audio-blocked': 2 }]);
    // The person clicks in the PAM tab, and the next clock tick starts the transport where the pattern is then.
    browser.pam.audio = 'running';
    await play(clock, { begin: 0.25, end: 0.5, cps: 0.5 });
    assert.deepEqual(pam.played, [
      { type: 'transport', time: at(750), action: 'seek', ppqPosition: 1 },
      { type: 'transport', time: at(750), action: 'play', bpm: 120 },
    ]);
    await play(clock, { begin: 0.5, end: 0.75, cps: 0.5 });
    assert.equal(pam.played.length, 2, 'once');
    // A tempo that PAM does not have is refused for good, and is not asked again with every tick.
    out.pamhush();
    await settle();
    pam.played.length = 0;
    pam.received.length = 0;
    await play(clock, { begin: 0, end: 0.25, cps: 20 });
    await play(clock, { begin: 0.25, end: 0.5, cps: 20 });
    assert.deepEqual([pam.messages('events').length, pam.played.map((event) => event.action)], [1, ['seek']]);

    // The two pages' clocks came apart while the scheduler was stopped: the start is refused as far
    // ahead, one event at a time, and goes again once the clocks have been compared.
    out.pamhush();
    await settle();
    pam.played.length = 0;
    browser.pam.clockAheadMs = -600_000;
    await play(clock, { begin: 0, end: 0.25, cps: 0.5 });
    await play(clock, { begin: 0.25, end: 0.5, cps: 0.5 });
    assert.deepEqual(pam.played, [
      { type: 'transport', time: at(750) - 600_000, action: 'seek', ppqPosition: 1 },
      { type: 'transport', time: at(750) - 600_000, action: 'play', bpm: 120 },
    ]);
  });

  test('a variation switch is with PAM more than a second before its time, once, and the notes go when the scheduler hands them over', async () => {
    const { pam } = await connect();
    // Half a cycle a second: a bar is two seconds, and each bar has its variation.
    await run(stack(variation('<1 2 3>'), s('1*4')).pam(), { seconds: 4.75, cps: 0.5 });
    assert.deepEqual(switched(pam), [
      [0, due(0), 250],
      [1, due(2), 1450],
      [2, due(4), 1450],
    ], 'the first is where the scheduler starts, and nothing was read before it. The others have 1.45 s, where PAM needs 0.4 s to prepare them');
    assert.equal(pam.played.filter((event) => event.type === 'variation').length, 3, 'none goes again when the scheduler delivers it');
    assert.deepEqual(pam.played.filter((event) => event.type === 'note').map((event) => event.time), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5].map(due));
    const { web, problems } = out.pamstatus();
    assert.deepEqual([web.shiftMs, web.aheadMs, web.refused, problems], [0, 250, {}, []], 'nothing is moved later to buy the time');
  });

  test('a switch that is sent ahead carries the mutes and solos as they will be when it lands, and what is set on its bar line rides it', async () => {
    const { pam } = await connect({ names: { hh: 3, rim: 6 } });
    const song = stack(
      variation('<4 1 2>'),
      knob('mute', '<1 ~ 0>').cell('rim'), // muted from the start, and lifted on the line of bar 2, where a switch is
      knob('mute', '<0 [~ ~ ~ 1] ~>').cell('hh'), // muted late in bar 1, after the switch of bar 2 has gone to PAM
    ).pam();
    await run(song, { seconds: 4.5, cps: 0.5 });
    assert.deepEqual(pam.switches.map((taken) => [taken.index, Math.round(taken.noticeMs), riders(taken)]), [
      [3, 250, ['mute 6 true', 'mute 3 false']],
      [0, 1450, ['mute 6 true', 'mute 3 false']],
      [1, 1450, ['mute 6 true', 'mute 3 true', 'mute 6 false']],
    ], 'bar 2: the rim as it was held, the hats as bar 1 will leave them, and then what the pattern sets on that line, which is last and wins');
    for (const taken of pam.switches) assert.deepEqual(taken.rode.map((event) => event.time), taken.rode.map(() => taken.time), 'each at the time of its switch, in its message');
    // What was read ahead is still sent at its own time, when the scheduler delivers it.
    assert.deepEqual(pam.played.filter((event) => event.type === 'mute' && event.cell === 3 && event.on).map((event) => event.time), [due(4), due(3.5)]);
    assert.deepEqual(out.pamstatus().problems, []);
  });

  test("how far ahead a switch goes is bounded by PAM's look-ahead, less the shift and the latency, so that nothing is refused as too far ahead", async () => {
    browser.pam.limits.lookaheadMs = 1600;
    browser.pam.leadMs = 350;
    const { pam } = await connect({ latency: 0.05 });
    await run(variation('<1 2>').pam(), { seconds: 1.5, cps: 0.5 });
    // 350 and 15 make 365, and events come 300 ms ahead with the latency: moved by 70. That leaves 1600 - 70 - 50 - 400 - 100 to read ahead, 980 ms.
    assert.deepEqual([switched(pam), out.pamstatus().web.shiftMs, out.pamstatus().web.refused], [[[0, due(0) + 120, 370], [1, due(2) + 120, 1370]], 70, {}]);
  });

  test('a switch that a pattern slowed after .pam() puts beyond PAM\'s look-ahead is left to the scheduler', async () => {
    const { pam } = await connect();
    await run(variation('<1 2 3>').pam().slow(2), { seconds: 4.75, cps: 0.5 });
    assert.deepEqual([switched(pam), out.pamstatus().web.refused], [[[0, due(0), 250], [1, due(4), 250]], {}]);
  });

  test('evaluating in the middle of a run sends no switch twice, and the code that is evaluated last has the last word', async () => {
    const { pam } = await connect();
    // Bar 1 starts at second 2, and its switch has been with PAM since second 0.8.
    await run(variation('<1 2 3>').pam(), { seconds: 1, cps: 0.5 });
    assert.deepEqual(switched(pam), [[0, due(0), 250], [1, due(2), 1450]]);

    // Code that asks for the same switch there, with notes in every tick after the one that reads the switch ahead again.
    await setup();
    await run(stack(variation('<~ 2 3>'), s('1*40')).pam(), { from: 1, seconds: 0.5, cps: 0.5 });
    assert.deepEqual([switched(pam).length, out.pamstatus().problems], [2, []]);

    // Code that asks for another variation on that bar line: it goes at once, behind the one that cannot be taken back.
    await setup();
    await run(variation('<1 4 3>').pam(), { from: 1.5, seconds: 0.25, cps: 0.5 });
    assert.deepEqual(switched(pam).slice(2), [[3, due(2), 750]]);
    assert.deepEqual(out.pamstatus().problems, [
      'PAM has a switch to variation 2 that is due in 750 ms, sent before the code changed. PAM cannot be asked to drop one switch, so it lands. The code now asks for variation 4 at that moment, and that was sent after it: PAM takes it where it still has the time to prepare it',
    ]);

    // Code with no switch there at all.
    await setup();
    await run(s('1*8').pam(), { from: 1.75, seconds: 2, cps: 0.5 });
    assert.deepEqual(out.pamstatus().problems, ['PAM has a switch to variation 4 that is due in 500 ms, sent before the code changed. PAM cannot be asked to drop one switch, so it lands, though the code no longer asks for it']);
    assert.equal(pam.switches.length, 3);
  });

  test('a tick that the scheduler skips loses its haps, and the next switch still carries the mute that was read ahead for it', async () => {
    const { pam } = await connect({ names: { rim: 6 } });
    const song = stack(variation('<1 2 3>'), knob('mute', '<1 0 1>').cell('rim')).pam();
    // The scheduler comes too late to the tick of second 2, where the rim is unmuted, and skips it.
    await run(song, { seconds: 2, cps: 0.5 });
    await run(song, { from: 2.05, seconds: 0.95, cps: 0.5 });
    assert.deepEqual(pam.switches.map((taken) => riders(taken)), [['mute 6 true'], ['mute 6 true', 'mute 6 false'], ['mute 6 false', 'mute 6 true']]);
  });

  test('what is set on the line of a switch rides it also where the scheduler reads its pattern in two parts, which gives it another sum for the same time', async () => {
    const { pam } = await connect({ names: { rim: 6 } });
    // A pattern that is asked for each tick in two halves, as one that is spliced or stretched after .pam() is.
    const halved = (pat) =>
      new Pattern((state) => {
        const middle = state.span.begin.add(state.span.end).div(2);
        const Span = state.span.constructor;
        return [new Span(state.span.begin, middle), new Span(middle, state.span.end)].flatMap((span) => pat.query(state.setSpan(span)));
      });
    await run(stack(variation('<1 2 3>').pam(), halved(knob('mute', '<~ 1 0>').cell('rim').pam())), { seconds: 3, cps: 0.55 });
    const [, first, second] = pam.switches;
    assert.deepEqual([riders(first), riders(second)], [['mute 6 true'], ['mute 6 true', 'mute 6 false']]);
    assert.deepEqual([...first.rode, ...second.rode].map((event) => event.time), [first.time, second.time, second.time]);
  });

  test('a mute that was read ahead counts for later switches only once the scheduler has handed it over', async () => {
    const { pam } = await connect({ names: { hh: 3 } });
    // Two cycles a second: a switch every half second. The hats are unmuted at second 0.75 and muted on the line of bar 2, with its switch.
    await run(stack(variation('<1 2 3 4>'), knob('mute', '<~ [~ 0] 1 ~>').cell('hh')).pam(), { seconds: 1, cps: 2 });
    assert.deepEqual(pam.switches.map((taken) => riders(taken)), [[], [], ['mute 3 false', 'mute 3 true'], ['mute 3 true'], ['mute 3 true']]);
  });

  test('after a hush nothing that was read ahead before it counts: PAM has dropped those switches', async () => {
    const { pam } = await connect({ names: { hh: 3 } });
    const song = stack(variation('<1 2 3>'), knob('mute', '<0 [~ ~ ~ 1]>').cell('hh')).pam();
    // The hats' mute at second 3.5 has been read ahead when the scheduler is stopped at second 2.5, and started again at once.
    await run(song, { seconds: 2.5, cps: 0.5 });
    out.pamhush();
    pam.switches.length = 0;
    await run(song, { from: 2.5, seconds: 1, cps: 0.5, cycle: 0 });
    assert.deepEqual(pam.switches.map((taken) => [taken.index, riders(taken)]), [[0, ['mute 3 false', 'mute 3 false']], [1, ['mute 3 false']]]);
  });

  test('a variation that a pattern first asks for after its eighth cycle is read ahead from the moment the scheduler hands it over', async () => {
    const { pam } = await connect();
    await run(variation('<~@8 2>').pam(), { seconds: 4.5, cps: 4 });
    assert.deepEqual(switched(pam), [[1, due(2), 250], [1, due(4.25), 1450]]);
  });

  test('the scheduler is not handed a change of tempo before its time', async () => {
    await connect();
    const song = stack(variation('<1 2>'), pure({ cps: 0.5 })).pam();
    const tempos = song.queryArc(0, 0.05, { _cps: 1, cyclist: 'cyclist' }).filter((hap) => hap.value.cps !== undefined);
    assert.deepEqual(tempos.map((hap) => Number(hap.whole.begin)), [0]);
  });

  test('new code is told only of switches that were sent ahead of the scheduler and have not been handed over by it', async () => {
    const { pam } = await connect();
    // A bar a second. At second 1.05 the switch of bar 1 has been handed over, and that of bar 2 has been sent ahead.
    await run(variation('<1 2 3>').pam(), { seconds: 1.05 });
    assert.deepEqual(switched(pam), [[0, due(0), 250], [1, due(1), 1250], [2, due(2), 1450]]);
    await setup();
    await run(s('1*8').pam(), { from: 1.05, seconds: 0.1 });
    assert.deepEqual(out.pamstatus().problems, ['PAM has a switch to variation 3 that is due in 1200 ms, sent before the code changed. PAM cannot be asked to drop one switch, so it lands, though the code no longer asks for it']);
  });

  test('a switch that has landed is not spoken of as still to come', async () => {
    await connect();
    await run(variation('<1 2 3>').pam(), { seconds: 1, cps: 0.5 });
    // Patterns with no switch are put in its place with no setup, and bar 1's switch lands at second 2. Then code with a setup.
    await run(s('1*8').pam(), { from: 1, seconds: 1.5, cps: 0.5 });
    await setup();
    await run(s('1*8').pam(), { from: 2.5, seconds: 0.25, cps: 0.5 });
    assert.deepEqual(out.pamstatus().problems, []);
  });

  test('a mute that replaced code had coming is not carried by the switches of the code that replaced it', async () => {
    const { pam } = await connect({ names: { hh: 3 } });
    // The hats are muted at second 3.5, which is read ahead at about second 2.3.
    await run(stack(variation('<1 2 3>'), knob('mute', '<0 [~ ~ ~ 1]>').cell('hh')).pam(), { seconds: 2.5, cps: 0.5 });
    await setup();
    await run(variation('<1 2 3>').pam(), { from: 2.5, seconds: 0.5, cps: 0.5 });
    assert.deepEqual(pam.switches.map((taken) => [taken.index, riders(taken)]), [[0, ['mute 3 false']], [1, ['mute 3 false']], [2, ['mute 3 false']]]);
  });

  test('a switch goes to PAM once: after a change of tempo it is not sent again, and what that means is said', async () => {
    const { pam } = await connect();
    const song = variation('<1 2 3>').pam();
    await run(song, { seconds: 1, cps: 0.5 });
    // The tempo doubles at second 1, half way through bar 0: bar 1 now starts at second 1.5, and bar 2 at second 2.5.
    await run(song, { from: 1, seconds: 1, cps: 1, cycle: 0.5 });
    assert.deepEqual(switched(pam), [[0, due(0), 250], [1, due(2), 1450], [2, due(2.5), 1450]], 'PAM would prepare a second switch to variation 2 again, and land it a bar late');
    assert.deepEqual(out.pamstatus().problems, [
      'the tempo changed after PAM was sent the switch to variation 2, and a switch cannot be sent twice: PAM would switch twice. It keeps the time that the old tempo gave it, 500 ms later than the pattern has it now',
    ]);
    // Code that sets the tempo back at second 2 finds the switch of bar 2 with PAM already, half a second early now.
    await setup();
    await run(variation('<1 2 3>').pam(), { from: 2, seconds: 1.25, cps: 0.5, cycle: 1.5 });
    assert.equal(pam.switches.length, 3);
    assert.deepEqual(out.pamstatus().problems, [
      'the tempo changed after PAM was sent the switch to variation 3, and a switch cannot be sent twice: PAM would switch twice. It keeps the time that the old tempo gave it, 500 ms earlier than the pattern has it now',
    ]);
  });

  test('code that changes a mute under a switch that has gone sends the mute at its own time, not the switch again, and says that it may not hold', async () => {
    const { pam } = await connect({ names: { hh: 3, rim: 6 } });
    // The switch of bar 1 goes to PAM at second 0.8, with the hats muted on its line.
    await run(stack(variation('<1 2 3>'), knob('mute', '<0 1 1>').cell('hh')).pam(), { seconds: 1, cps: 0.5 });
    assert.deepEqual(riders(pam.switches[1]), ['mute 3 false', 'mute 3 true']);
    // Code that leaves the hats on there, and mutes the rim.
    await setup({ names: { hh: 3, rim: 6 } });
    pam.played.length = 0;
    const changed = () => stack(variation('<1 2 3>'), knob('mute', '<0 0 1>').cell('hh'), knob('mute', '<~ 1 1>').cell('rim')).pam();
    const second = changed();
    await run(second, { from: 1, seconds: 1.25, cps: 0.5 });
    assert.equal(pam.switches.length, 2, 'the switch does not go again');
    assert.deepEqual(pam.played.map((event) => [event.type, event.cell, event.on, event.time]), [
      ['mute', 3, false, due(2)],
      ['mute', 6, true, due(2)],
    ]);
    assert.deepEqual(out.pamstatus().problems, [
      'PAM was sent the switch to variation 2 before the code had the mute of cell 3, the mute of cell 6 as it is now, and a switch cannot be sent twice: PAM would switch twice. What the code sets is sent at its own time, and may not hold until the next switch',
    ]);

    // The switch of bar 2 goes at second 2.8, with both mutes on its line. The same code evaluated again under it says nothing.
    await run(second, { from: 2.25, seconds: 0.75, cps: 0.5 });
    await setup({ names: { hh: 3, rim: 6 } });
    await run(changed(), { from: 3, seconds: 1.25, cps: 0.5 });
    assert.deepEqual([pam.switches.length, riders(pam.switches[2]), out.pamstatus().problems], [3, ['mute 3 false', 'mute 6 true', 'mute 3 true', 'mute 6 true'], []]);
  });

  test('a page that has asked for no variation is read as the scheduler asks and no further: reading ahead costs only a song that switches', async () => {
    await connect();
    const read = [];
    const watched = () =>
      new Pattern((state) => {
        if (state.controls.cyclist) read.push([state.span.begin, state.span.end].map((edge) => Math.round(Number(edge) * 1e6) / 1e6));
        return s('1*4').query(state);
      });
    await run(stack(watched().pam(), knob('mute', '<1 0>').cell(2).pam()), { seconds: 0.5 });
    assert.deepEqual(read, Array.from({ length: 10 }, (_, k) => [k, k + 1].map((edge) => Math.round(edge * TICK * 1e6) / 1e6)));

    // A song whose variation starts in its fifth cycle: from the first tick, every pattern is read ahead as well,
    // since what rides a switch can be in any of them. Each stretch is read ahead once.
    read.length = 0;
    await setup();
    const song = stack(watched().pam(), variation('<~@4 2>').pam());
    await run(song, { from: 0.5, seconds: 0.5 });
    const ahead = read.filter((span, i) => i % 2 === 1);
    assert.equal(read.length, 20);
    assert.deepEqual([ahead[0], ahead.at(-1)[1], ahead.every((span, i) => i === 0 || span[0] === ahead[i - 1][1])], [[0.55, 1.75], 2.2, true]);

    // The editor reads the patterns too, to draw them, between the scheduler's ticks. The next tick goes on from where reading ahead had come.
    read.length = 0;
    song.queryArc(0, 4, { _cps: 1 });
    await run(song, { from: 1, seconds: 0.05 });
    assert.deepEqual(read, [[1, 1.05], [2.2, 2.25]]);
  });

  test('the clocks are compared again at every setup, and at once when PAM calls events far from their time', async () => {
    const { status, pam } = await connect();
    assert.equal(status.web.clockMs, undefined);
    // The computer slept, and the two pages' clocks did not stop for the same length.
    browser.pam.clockAheadMs = 600_000;
    assert.equal((await setup()).web.clockMs, 600_000, 'the next evaluation finds it');
    await play(s('1').pam());
    assert.deepEqual([pam.played.map((event) => event.time), out.pamstatus().web.refused], [[at(250) + 600_000], {}]);

    // It happens again, and this time nothing is evaluated: the scheduler just plays on.
    browser.pam.clockAheadMs = 4_200_000;
    await play(s('1').pam());
    let { web, problems } = out.pamstatus();
    assert.deepEqual([web.refused, web.tooLate, web.enoughMs, web.shiftMs], [{ too_late: 1 }, 0, undefined, 0], 'an hour late is not a look-ahead to learn from');
    assert.match(problems.join('\n'), /PAM refused events as far from their time, which means that the two pages' clocks have come apart since they were compared, as they do when the computer sleeps\. They are being compared again/);
    assert.equal(web.clockMs, 4_200_000, 'compared again, with no evaluation');
    await play(s('1').pam());
    assert.equal(pam.played.at(-1).time, at(250) + 4_200_000);

    // The other way: this page's clock ran on and PAM's stood still, so events look far ahead to PAM.
    browser.pam.clockAheadMs = 0;
    await play(s('1').pam());
    ({ web } = out.pamstatus());
    assert.deepEqual([web.refused.too_far_ahead, web.clockMs], [1, undefined]);
    await play(s('1').pam());
    assert.equal(pam.played.at(-1).time, at(250));
  });

  test("a figure that one PAM's answers gave is not planned by for another PAM", async () => {
    const { pam } = await connect();
    browser.pam.leadMs = 20;
    await play(s('1').pam());
    assert.equal(out.pamstatus().web.leadMs, 20);
    // Another PAM, which welcomes with a figure too low, as one whose audio has not started does.
    pam.close();
    if (way === 'channel') await settle();
    browser.pam = { ...defaultPam(), welcomeLeadMs: 9, leadMs: 75 };
    if (way === 'channel') browser.arm(ROOM);
    await setup({ web: way === 'channel' ? { room: ROOM, site: PAM_ORIGIN } : 'https://map.audio/pam/play' });
    const next = browser.pages.at(-1);
    await play(s('1').pam(), { ahead: 0.05 });
    assert.deepEqual([next.played.map((event) => event.time), out.pamstatus().web.refused], [[at(120)], {}], "planned by 100 ms until the new PAM answers: the old PAM's 20 would have gone at 50 and been refused");
  });

  test('an event that PAM refuses as too late is counted, with the look-ahead that would have been enough, and the next ones get it', async () => {
    const { pam } = await connect();
    browser.pam.leadMs = 250; // a wireless headset was connected: PAM's lead grew, and the sender has not heard yet
    await play(s('1').pam(), { ahead: 0.125 });
    assert.equal(pam.played.length, 0, 'PAM does not play a late event at another time');
    let { web, problems } = out.pamstatus();
    assert.deepEqual([web.refused, web.tooLate, web.enoughMs, web.leadMs, web.accepted], [{ too_late: 1 }, 1, 250, 250, 0]);
    assert.match(problems.join('\n'), /PAM refused events that reached it too late, and did not play them\. pamstatus\(\)\.web\.enoughMs is the look-ahead that would have been enough/);

    await play(s('1').pam(), { ahead: 0.125 });
    assert.deepEqual(pam.played.map((event) => event.time), [at(265)]);
    ({ web } = out.pamstatus());
    assert.deepEqual([web.shiftMs, web.accepted, web.tooLate], [140, 1, 1]);
  });

  test('how long a message takes to reach PAM is read from its answers, and planned for before anything is refused', async () => {
    const { pam } = await connect();
    browser.pam.crossingMs = 60; // PAM's page takes that long to read a message
    await play(s('1').pam());
    assert.deepEqual([out.pamstatus().web.transitMs, out.pamstatus().web.accepted], [60, 1], 'a quarter of a second ahead: accepted, and the 60 ms were seen');
    await play(s('1').pam(), { ahead: 0.09 });
    const { web } = out.pamstatus();
    assert.deepEqual([web.shiftMs, web.accepted, web.refused], [10, 2, {}], '40 ms of lead and 60 on the way make 100: with the fixed 15 it would have gone at 90 and been refused');
    assert.equal(pam.played[1].time, at(100));
    assert.equal((await setup()).web.transitMs, 60, 'an evaluation in the middle of a run keeps it');
    out.pamhush();
    assert.equal(out.pamstatus().web.transitMs, undefined, 'a new run starts from what it sees itself');
  });

  test("a message that was slow to reach PAM teaches the sender too: PAM's lead has not changed, and what would have been enough has", async () => {
    const { pam } = await connect();
    browser.pam.crossingMs = 150; // PAM's page was busy for that long before it read the message
    await play(s('1').pam(), { ahead: 0.125 });
    let { web } = out.pamstatus();
    assert.deepEqual([web.refused, web.enoughMs, web.leadMs, web.shiftMs], [{ too_late: 1 }, 190, 40, 0], '125 ms of look-ahead, and PAM says 65 more were needed');
    await play(s('1').pam(), { ahead: 0.125 });
    assert.deepEqual(pam.played.map((event) => event.time), [at(205)]);
    ({ web } = out.pamstatus());
    assert.deepEqual([web.shiftMs, web.accepted], [80, 1]);
  });

  test('the two pages count time from when each was loaded: a difference is measured at the welcome, and every time is sent as PAM reads it', async () => {
    browser.pam.clockAheadMs = 7_200_000; // this page was open before the computer slept for two hours, and PAM's was loaded after
    const { status, pam } = await connect();
    assert.equal(status.web.clockMs, 7_200_000);
    assert.deepEqual(requests(pam), ['hello']);
    assert.equal(pam.messages('getTransport').length, 3, 'three readings');
    await play(s('1 2').pam(), { cps: 2 });
    assert.deepEqual(pam.played.map((event) => event.time), [at(250) + 7_200_000, at(500) + 7_200_000]);
    const { web } = out.pamstatus();
    assert.deepEqual([web.accepted, web.refused, web.shiftMs], [2, {}, 0], 'nothing is refused as hours late, and nothing is moved');
    browser.pam.leadMs = 250;
    await play(s('1').pam(), { ahead: 0.125 });
    assert.equal(out.pamstatus().web.enoughMs, 250, 'what would have been enough is a look-ahead, whichever clock it is read on');
  });

  test('a difference that the reading itself could be out by is left alone, and the shortest of three round trips is the one believed', async () => {
    browser.pam.clockAheadMs = 0;
    browser.pam.trip = { there: 30, back: 10 }; // the answer comes back faster than the question went: the middle is 10 ms out
    const even = await connect();
    assert.equal(even.status.web.clockMs, undefined, '10 ms inside a round trip of 40 is no difference');
    await play(s('1').pam());
    assert.equal(even.pam.played[0].time, at(250));
  });

  test("PAM's refusals are counted by code and said once for each thing refused", async () => {
    const { pam } = await connect();
    await play(stack(s('4*4'), note('c2').s('1'), knob('pan', 0.5).cell(2), s('2')).pam());
    const { web, problems } = out.pamstatus();
    assert.deepEqual([web.sent, web.accepted], [7, 1]);
    assert.deepEqual(web.refused, { cell_not_armed: 4, cell_not_pitched: 1, unknown_parameter: 1 });
    assert.deepEqual(pam.played, [{ type: 'note', time: at(250), cell: 2, velocity: 0.9, duration: 1000 }], 'one refusal does not stop the rest');
    assert.deepEqual(problems, [
      'PAM refused a note on cell 4 (cell_not_armed): the stand-in says cell_not_armed. arm the cell in PAM',
      'PAM refused a note on cell 1 (cell_not_pitched): the stand-in says cell_not_pitched. the cell plays one pitch in this preset: leave note and n out, or make it poly',
      'PAM refused cell2_pan (unknown_parameter): the stand-in says unknown_parameter',
    ]);
  });

  test('a tick with more events than PAM takes in one message goes as several', async () => {
    browser.pam.limits.eventsPerMessage = 4;
    const { pam } = await connect();
    await play(s('1*10').pam());
    assert.deepEqual(pam.messages('events').map((message) => message.events.length), [4, 4, 2]);
    assert.equal(pam.played.length, 10);
    assert.equal(out.pamstatus().web.accepted, 10);
  });

  test('a person who disconnects the page in PAM, and a PAM that has dropped it, both end the sending until the next evaluation', async () => {
    const { pam } = await connect();
    pam.disconnect('disconnected in PAM');
    await settle();
    assert.equal(out.pamstatus().web.state, 'disconnected');
    assert.match(out.pamstatus().problems.join('\n'), /PAM disconnected this page \(disconnected in PAM\): evaluate again to reconnect/);
    await play(s('1').pam());
    assert.equal(out.pamstatus().dropped, 1);

    assert.equal((await setup()).web.state, 'connected');
    pam.forget();
    await play(s('1').pam());
    const { web, problems } = out.pamstatus();
    assert.equal(web.state, 'disconnected');
    assert.deepEqual(web.refused, { not_connected: 1 });
    assert.match(problems.join('\n'), /PAM no longer takes events from this page: evaluate again to reconnect/);
  });

  test('a PAM that cannot make sound yet says so, and the person is told to click in its tab', async () => {
    browser.pam.audio = 'blocked';
    const { pam } = await connect();
    await play(s('1*2').pam());
    let { web, problems } = out.pamstatus();
    assert.deepEqual(web.refused, { 'audio-blocked': 2 });
    assert.deepEqual(problems, ['PAM refused 2 events at once (audio-blocked): the stand-in says audio-blocked. click in the PAM tab so that it can make sound']);
    pam.say({ kind: 'status', connected: true, audio: 'blocked', engine: 'running' });
    await settle();
    ({ web, problems } = out.pamstatus());
    assert.equal(web.audio, 'blocked');
    assert.match(problems.join('\n'), /PAM cannot make sound yet: click in the PAM tab so that it can make sound/);

    browser.pam.audio = 'running';
    pam.say({ kind: 'status', connected: true, audio: 'running', engine: 'running' });
    await play(s('1').pam());
    ({ web } = out.pamstatus());
    assert.deepEqual([web.audio, web.state, web.accepted], ['running', 'connected', 1]);
  });

  test("follow is refused with the web output, and PAM's clock is not read", async () => {
    let made = 0;
    browser.env.EventSource = class {
      constructor() {
        made++;
      }
    };
    const { status } = await connect({ follow: true });
    assert.match(status.problems.join('\n'), /follow is not in the web output: PAM in the browser does not send its clock to the page that plays it\. Leave follow out, and pamclock\(\) runs PAM from here/);
    assert.equal(status.clock, undefined);
    assert.equal(made, 0);
    assert.equal(status.web.state, 'connected');
  });

  test('preset: a PAM that is open is asked to load it, an unknown one lists what PAM has, and a preset loaded in PAM is heard of', async () => {
    const { pam } = await connect();
    const next = await setup({ preset: 'haze-garden' });
    assert.deepEqual(pam.messages('loadPreset').map((message) => message.slug), ['haze-garden']);
    assert.equal(next.web.welcome.preset, 'haze-garden');

    const unknown = await setup({ preset: 'soft-launch', poly: [5, 7, 8] });
    assert.deepEqual(unknown.problems, ['this PAM has no preset "soft-launch". It has: night-shift, cold-rail, haze-garden']);
    assert.equal(unknown.web.welcome.preset, 'haze-garden');

    // The person loads another preset in PAM, where cell 5 plays one pitch.
    const cells = defaultPam().cells.map((cell) => (cell.cell === 5 ? { ...cell, pitched: false } : cell));
    pam.load('night-shift', cells);
    await settle();
    const after = out.pamstatus();
    assert.equal(after.web.welcome.preset, 'night-shift');
    assert.equal(after.web.welcome.cells[4].pitched, false);
    assert.match(after.problems.join('\n'), /poly: the setup says that cells 5, 7, 8 play by pitch, and in this PAM cells 7, 8 do/);
  });

  test('a setup that no longer says web goes back to MIDI, and says goodbye to PAM', async () => {
    const { pam } = await connect();
    const bytes = [];
    const status = await out.pamsetup({ output: { send: (message) => bytes.push([...message]) } });
    await settle();
    assert.equal(status.web, undefined);
    assert.equal(pam.kinds().at(-1), 'bye');
    await play(s('1').pam());
    assert.deepEqual(bytes, [[0x90, 48, 114], [0x80, 48, 0]]);
    assert.equal(pam.messages('events').length, 0);
  });
});

test("which PAM: the importing site's, the one named, or the one that listens under a code. Anything else is refused with what to write", async () => {
  assert.deepEqual(playTarget(true, HOME), { page: 'https://map.audio/pam/play', origin: PAM_ORIGIN });
  assert.deepEqual(playTarget(true, 'http://localhost:4747/src/strudel/output.mjs'), { page: 'http://localhost:4747/pam/play', origin: 'http://localhost:4747' });
  assert.deepEqual(playTarget('https://staging.map.audio'), { page: 'https://staging.map.audio/pam/play', origin: 'https://staging.map.audio' });
  assert.deepEqual(playTarget('http://localhost:5173/pam/play?webapp=1'), { page: 'http://localhost:5173/pam/play?webapp=1', origin: 'http://localhost:5173' });
  assert.deepEqual(playTarget({ site: 'https://staging.map.audio' }), playTarget('https://staging.map.audio'));
  assert.deepEqual(playTarget({ room: ROOM }, HOME), { page: 'https://map.audio/pam/play', origin: PAM_ORIGIN, room: ROOM });
  assert.deepEqual(playTarget({ room: ROOM, site: 'http://localhost:5173' }), { page: 'http://localhost:5173/pam/play', origin: 'http://localhost:5173', room: ROOM });
  assert.throws(() => playTarget(true, 'file:///work/mapuzu.mjs'), /was not imported from a site\. Give PAM's address: pamsetup\(\{ web: 'https:\/\/map\.audio' \}\)/);
  assert.throws(() => playTarget(true, undefined), /was not imported from a site/);
  assert.throws(() => playTarget({ room: ROOM }), /was not imported from a site/);
  assert.throws(() => playTarget('map.audio'), /web: "map\.audio" is not the address of a PAM page/);
  assert.throws(() => playTarget({ room: 'k3f9' }, HOME), /web: \{ room: "k3f9" \} is not a code from a PAM page\. Copy the line that PAM's page gives, with its single quotes/);
  assert.throws(() => playTarget({ rom: ROOM }, HOME), /web: \{ rom \} is not something it takes\. It takes \{ room: 'the code from PAM' \} and \{ site: 'https:\/\/map\.audio' \}/);

  const fromNpm = createOutput(strudelCore, browser.env);
  const status = await fromNpm.pamsetup({ web: true });
  assert.deepEqual(status.web, { state: 'unavailable' });
  assert.match(status.problems.join('\n'), /was not imported from a site/);
  assert.deepEqual(browser.opened, [], 'nothing is opened');
  await play(s('1').pam());
  assert.equal(fromNpm.pamstatus().dropped, 1, 'and nothing falls back to MIDI');
});

test('the pure halves: MIDI start, stop and continue keep their meaning, a setup is compared with any welcome, and preset without web is said', async () => {
  const transport = [{ type: 'transport', command: 'start' }, { type: 'transport', command: 'stop' }, { type: 'transport', command: 'continue' }];
  assert.deepEqual(toPlayEvents(transport).events, [
    { type: 'transport', action: 'seek', ppqPosition: 0 },
    { type: 'transport', action: 'play' },
    { type: 'transport', action: 'stop' },
    { type: 'transport', action: 'play' },
  ]);
  assert.deepEqual(toPlayEvents([{ type: 'note', cell: 9, n: 2, velocity: 1 }], { time: 1, duration: 1, cells: [] }), {
    events: [],
    unsupported: ['n on cell 9 is not sent: PAM named no root note for that cell'],
  });

  const small = { cells: defaultPam().cells.slice(0, 4) };
  assert.deepEqual(checkSetup(small, createSetup({ names: { pad: 8 }, poly: [8] }), { names: { pad: 8 }, poly: [8] }), ['names: "pad" is cell 8, and this PAM has 4 cells']);
  assert.deepEqual(checkSetup(defaultPam(), createSetup({ roots: 48 }), { roots: 48 }), ["roots: cell 5's root is 48 in the setup and 36 in this PAM. n() counts from PAM's"]);
  assert.deepEqual(checkSetup(defaultPam(), createSetup({ poly: [] }), { poly: [] }), ["poly: the setup says that cells none play by pitch, and in this PAM cells 5, 7, 8 do. PAM's own are what plays"]);
  assert.deepEqual(checkSetup(undefined, createSetup(), {}), []);

  const midi = await out.pamsetup({ output: { send() {} }, preset: 'cold-rail' });
  assert.deepEqual(midi.problems, ['preset is read by the web output only: without web, load the preset in PAM yourself']);
});

describe("the audio context of the page that runs Strudel, which every time is read from", () => {
  // Strudel's audio context as far as the output touches it: it makes constants, and says which it has made.
  function audioContext({ constants = true } = {}) {
    const context = { made: [], destination: { is: 'the destination' } };
    context.createConstantSource = () => {
      if (!constants) throw new TypeError('context.createConstantSource is not a function');
      const source = { offset: { value: 1 }, to: [], started: 0, connect: (node) => source.to.push(node), start: () => source.started++, disconnect: () => (source.to.length = 0) };
      context.made.push(source);
      return source;
    };
    return context;
  }

  test('a page that sends to PAM keeps one constant far below hearing in it, so that Chrome does not take a silent context off the audio device after thirty seconds', async () => {
    const context = audioContext();
    browser.env.getAudioContext = () => context;
    assert.equal(context.made.length, 0, 'a page that only loaded the module has none');
    const status = await out.pamsetup({ web: true });
    assert.equal(status.web.state, 'connected');
    const [source] = context.made;
    assert.deepEqual([context.made.length, source.offset.value, source.to, source.started], [1, 1e-6, [context.destination], 1]);
    await play(s('1*4').pam());
    await out.pamsetup({ web: true });
    await play(s('1*4').pam());
    assert.equal(context.made.length, 1, 'one, however often the code is evaluated and however long it plays');

    // Strudel makes its audio context anew: that one gets its own.
    const another = audioContext();
    browser.env.getAudioContext = () => another;
    await play(s('1').pam());
    assert.equal(another.made.length, 1);
    // An output that is reset takes its constant out, and puts one in again when it next sends.
    out.reset();
    assert.deepEqual(another.made[0].to, []);
    await out.pamsetup({ web: true });
    assert.equal(another.made.length, 2);
  });

  test('the times of the MIDI output are read from the same context, so a page that sends MIDI keeps the constant too', async () => {
    const context = audioContext();
    browser.env.getAudioContext = () => context;
    await out.pamsetup({ output: { send() {} } });
    assert.deepEqual(context.made.map((source) => [source.offset.value, source.started]), [[1e-6, 1]]);
  });

  test('a context that makes no constant, and a page with no audio context, are played as they are', async () => {
    const context = audioContext({ constants: false });
    browser.env.getAudioContext = () => context;
    const pam = await out.pamsetup({ web: true }).then(() => browser.pages.at(-1));
    await play(s('1').pam());
    assert.deepEqual([pam.played.length, out.pamstatus().problems], [1, []]);
    browser.env.getAudioContext = () => {
      throw new Error('no audio here');
    };
    await play(s('1').pam());
    assert.deepEqual([pam.played.length, out.pamstatus().problems], [2, []]);
  });
});

describe("PAM's own tab, by postMessage", () => {
  async function connect(options = {}) {
    const status = await out.pamsetup({ web: true, ...options });
    return { status, tab: browser.pages.at(-1) };
  }

  test('pamsetup({ web: true }) opens the PAM page of the site the module came from, says hello when PAM is ready, and waits for Allow', async () => {
    browser.pam.allow = 'ask';
    let resolved = false;
    const pending = out.pamsetup({ web: true }).then((status) => {
      resolved = true;
      return status;
    });
    await settle();
    const tab = browser.pages[0];
    assert.deepEqual(browser.opened, [['', 'pam-play']], 'the tab is found or made by name, so a PAM left open is not loaded again');
    assert.equal(tab.address, 'https://map.audio/pam/play');
    assert.deepEqual(tab.received, [{ channel: CHANNEL, kind: 'hello', id: 1, protocol: 1, name: 'mapuzu' }]);
    assert.deepEqual([...tab.addressedTo], [PAM_ORIGIN], "it is addressed to PAM's origin and to no other");
    assert.equal(resolved, false, 'the setup waits for the person at the PAM tab');
    assert.equal(out.pamstatus().web.state, 'waiting');

    tab.allow();
    const status = await pending;
    assert.deepEqual([status.web.state, status.web.via, status.web.page], ['connected', 'tab', 'https://map.audio/pam/play']);
    assert.deepEqual(browser.requests, [], "PAM's site is asked nothing: two tabs that can talk need no pairing");
    await play(s('1').pam());
    assert.deepEqual([...tab.addressedTo], [PAM_ORIGIN]);
  });

  test('a PAM on a site that is named is opened there', async () => {
    browser.pam.origin = 'http://localhost:5173';
    const { status, tab } = await connect({ web: 'http://localhost:5173' });
    assert.equal(tab.address, 'http://localhost:5173/pam/play');
    assert.equal(status.web.state, 'connected');
  });

  test('after Deny, the next evaluation asks in a new tab once the old one is closed', async () => {
    browser.pam.allow = 'no';
    const { tab } = await connect();
    assert.equal((await out.pamsetup({ web: true })).web.state, 'denied');
    assert.equal(browser.opened.length, 1, 'the same tab is asked while it is open');
    tab.close();
    browser.pam = { ...browser.pam, allow: 'yes' };
    const again = await out.pamsetup({ web: true });
    assert.equal(again.web.state, 'connected');
    assert.deepEqual(again.problems, []);
    assert.equal(browser.pages.length, 2);
  });

  test('an evaluation that overtakes one still waiting for Allow asks again, and only the newer one goes on', async () => {
    browser.pam.allow = 'ask';
    let first = false;
    out.pamsetup({ web: true }).then(() => (first = true));
    await settle();
    const second = out.pamsetup({ web: true });
    await settle();
    browser.pages[0].allow();
    assert.equal((await second).web.state, 'connected');
    await settle();
    assert.equal(first, false, 'the overtaken evaluation never resumes, so it cannot set its patterns over the newer ones');
    assert.deepEqual(requests(browser.pages[0]), ['hello', 'hello']);
    assert.equal(browser.pages.length, 1);
  });

  test("messages that are not from the PAM tab, from PAM's origin and on the channel are ignored", async () => {
    browser.pam.allow = 'ask';
    const pending = out.pamsetup({ web: true });
    await settle();
    const tab = browser.pages[0];
    const welcome = { channel: CHANNEL, kind: 'ack', id: 1, ok: true, result: { protocol: 1, cells: [], timing: { leadMs: 1 }, preset: 'forged' } };
    browser.deliver({ origin: 'https://elsewhere.example', source: tab.window, data: welcome });
    browser.deliver({ origin: PAM_ORIGIN, source: { closed: false }, data: welcome });
    browser.deliver({ origin: PAM_ORIGIN, source: tab.window, data: { ...welcome, channel: 'pam-learn-v1' } });
    browser.deliver({ origin: PAM_ORIGIN, source: tab.window, data: null });
    await settle();
    assert.equal(out.pamstatus().web.state, 'waiting');
    tab.allow();
    assert.equal((await pending).web.welcome.preset, 'night-shift');
  });

  test('a reading of the clock belongs to the PAM it was taken from, and the shortest round trip is believed whichever came first', async () => {
    browser.pam.clockAheadMs = 7_200_000;
    const { status, tab } = await connect();
    assert.equal(status.web.clockMs, 7_200_000);
    tab.close();
    browser.pam = { ...defaultPam(), allow: 'no' };
    assert.equal((await out.pamsetup({ web: true })).web.clockMs, undefined);
    browser.pages[1].close();
    // One slow, uneven round trip, then two short, even ones.
    browser.pam = { ...defaultPam(), clockAheadMs: 500, trips: [{ there: 30, back: 10 }, { there: 2, back: 2 }, { there: 3, back: 3 }] };
    assert.equal((await out.pamsetup({ web: true })).web.clockMs, 500, 'the uneven one would have said 510');
    browser.pages[2].close();
    browser.pam = { ...defaultPam(), clockAheadMs: -90_000, trips: [{ there: 30, back: 10 }, { there: 40, back: 40 }, { there: 60, back: 20 }] };
    assert.equal((await out.pamsetup({ web: true })).web.clockMs, -89_990, 'the shortest is believed, even or not');
    await play(s('1').pam());
    assert.deepEqual(browser.pages[3].played.map((event) => event.time), [at(250) - 89_990]);
  });

  test('a PAM tab that was closed is noticed at the next event, and the next evaluation opens a new one', async () => {
    const { tab } = await connect();
    tab.close();
    await play(s('1 2').pam());
    await play(s('1').pam());
    let status = out.pamstatus();
    assert.equal(status.web.state, 'closed');
    assert.equal(status.dropped, 3);
    assert.match(status.problems.join('\n'), /the PAM tab is closed: evaluate again to open it/);

    status = await out.pamsetup({ web: true });
    assert.equal(status.web.state, 'connected');
    assert.equal(browser.pages.length, 2);
    await play(s('1').pam());
    assert.equal(browser.pages[1].played.length, 1);
    assert.equal(tab.played.length, 0);
  });

  test('a PAM tab that was loaded again has forgotten the page: nothing is sent until the next evaluation says hello', async () => {
    const { tab } = await connect();
    tab.reload();
    await settle();
    let status = out.pamstatus();
    assert.equal(status.web.state, 'disconnected');
    assert.match(status.problems.join('\n'), /the PAM tab was loaded again, so PAM no longer knows this page: evaluate again to reconnect/);
    await play(s('1').pam());
    assert.equal(out.pamstatus().dropped, 1);
    assert.deepEqual(requests(tab), ['hello']);

    status = await out.pamsetup({ web: true });
    assert.equal(status.web.state, 'connected');
    assert.deepEqual(requests(tab), ['hello', 'hello']);
    assert.equal(browser.opened.length, 1, 'the tab is still there, so none is opened');
  });

  test('a PAM tab left open from before this page was loaded again is found by its name and is not loaded again', async () => {
    const tab = browser.keepTab();
    await settle();
    const status = await out.pamsetup({ web: true, preset: 'cold-rail' });
    assert.equal(status.web.state, 'connected');
    assert.equal(browser.pages.length, 1);
    assert.equal(tab.loads, 1);
    assert.deepEqual(requests(tab), ['ping', 'hello', 'loadPreset'], 'it is asked whether it is PAM, then greeted. Its preset is changed by asking, since its address cannot be');
    assert.equal(status.web.welcome.preset, 'cold-rail');
  });

  test('a PAM from before ping existed refuses it, which is an answer too', async () => {
    browser.pam.pings = false;
    const tab = browser.keepTab();
    await settle();
    assert.equal((await out.pamsetup({ web: true })).web.state, 'connected');
    assert.deepEqual(requests(tab), ['ping', 'hello']);
  });

  test('a tab of that name that has gone to another page does not answer the ping, and is sent to PAM', async () => {
    vi.useFakeTimers();
    const tab = browser.keepTab();
    await vi.advanceTimersByTimeAsync(0);
    tab.elsewhere = true; // the person followed a link in it: it is on another site now
    const pending = out.pamsetup({ web: true, preset: 'cold-rail' });
    await vi.advanceTimersByTimeAsync(1400);
    assert.deepEqual([out.pamstatus().web.state, tab.loads], ['opening', 1]);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    const status = await pending;
    assert.deepEqual([status.web.state, tab.loads, tab.address], ['connected', 2, 'https://map.audio/pam/play?preset=cold-rail']);
    assert.deepEqual(requests(tab), ['hello'], 'the ping went to the other site, which was not handed it');
    assert.equal(browser.pages.length, 1, 'the same tab is used');
  });

  test('preset: a new tab is opened on it, so PAM starts with it and is not asked to load it', async () => {
    const { status, tab } = await connect({ preset: 'cold-rail' });
    assert.equal(tab.address, 'https://map.audio/pam/play?preset=cold-rail');
    assert.equal(status.web.welcome.preset, 'cold-rail');
    assert.equal(tab.messages('loadPreset').length, 0);
  });

  test('where the browser will not open the tab, the address is shown under a code to be opened by hand, and having no browser at all is said', async () => {
    browser.blocked = true;
    const pending = out.pamsetup({ web: true });
    await settle();
    const { web, problems } = out.pamstatus();
    assert.equal(web.state, 'pairing');
    assert.deepEqual(problems, [`the browser did not open PAM's tab. Open this address yourself, in this browser, and PAM pairs with this page: ${web.link}`]);
    browser.visit(web.link);
    const status = await pending;
    assert.deepEqual([status.web.state, status.web.via], ['connected', 'channel'], 'a code works from every page');

    const nowhere = () => createOutput(strudelCore, { performance: globalThis.performance }, HOME);
    const noWindow = await nowhere().pamsetup({ web: true });
    assert.equal(noWindow.web.state, 'unavailable');
    assert.match(noWindow.problems.join('\n'), /the web output needs a browser: there is no window here to open PAM in/);
    // A code from PAM's page needs no window, only what a pairing needs.
    const noWebrtc = await nowhere().pamsetup({ web: { room: ROOM } });
    assert.deepEqual([noWebrtc.web.state, noWebrtc.problems], ['unpaired', ['this browser has no WebRTC, which is how this page would reach a PAM tab']]);
  });

  test("a page that runs Strudel has Strudel's patterns where the window's open, close, focus and frames were: PAM's tab is opened and found again by the three-argument document.open", async () => {
    browser.runsStrudel();
    const status = await out.pamsetup({ web: true });
    assert.deepEqual([status.web.state, status.web.via, status.problems], ['connected', 'tab', []]);
    assert.deepEqual([browser.opened, browser.cleared], [[['', 'pam-play']], false]);
    // The page is loaded again, and finds the tab it had opened.
    load();
    browser.runsStrudel();
    const again = await out.pamsetup({ web: true });
    assert.deepEqual([again.web.state, browser.opened.length, browser.pages.length, browser.cleared], ['connected', 2, 1, false]);
  });
});

describe('a data channel, paired under a room code', () => {
  const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  // A sending page that the browser keeps apart from tabs of other sites, as it keeps strudel.cc.
  const keptApart = () => {
    browser.env.crossOriginIsolated = true;
    browser.cutsOpener = true;
  };

  // strudel.cc as Chrome 157 showed it: kept apart from other sites' tabs, and `typeof window.open` is "object".
  const strudelCc = () => {
    keptApart();
    browser.runsStrudel();
  };

  test("on strudel.cc a code from PAM's page pairs and plays: no tab is opened, so nothing of the window's is needed", async () => {
    strudelCc();
    const pam = browser.arm(ROOM);
    const status = await out.pamsetup({ web: { room: ROOM, site: PAM_ORIGIN } });
    assert.deepEqual([status.web.state, status.web.via, status.problems, browser.opened], ['connected', 'channel', [], []]);
    await play(s('1').pam());
    assert.deepEqual([pam.played.length, out.pamstatus().web.accepted, browser.cleared], [1, 1, false]);
  });

  test("on strudel.cc web: true opens PAM's tab by the three-argument document.open, inside the call", async () => {
    // Strudel's `open` is a pattern today. Were it one of Strudel's functions, what it gives would be no window either.
    for (const functions of [false, true]) {
      browser = createBrowser();
      load();
      keptApart();
      browser.runsStrudel({ functions });
      const pending = out.pamsetup({ web: true });
      const link = `https://map.audio/pam/play#room=${out.pamstatus().web.room}`;
      assert.deepEqual([browser.opened, browser.cleared], [[[link, 'pam-play']], false]);
      const status = await pending;
      assert.deepEqual([status.web.state, status.web.via, status.problems], ['connected', 'channel', []]);
    }
  });

  test('a browser whose document.open had only the form that clears the page is never asked to open a tab with it: the address is shown', async () => {
    // Such a browser opens a document that has no window for writing, or refuses for a reason of its own.
    for (const refusal of [undefined, 'InvalidStateError']) {
      browser = createBrowser();
      Object.assign(browser, { threeArgumentOpen: false, throwawayRefuses: refusal });
      load();
      strudelCc();
      const pending = out.pamsetup({ web: true });
      await settle();
      const { web, problems } = out.pamstatus();
      assert.deepEqual([web.state, browser.opened, browser.cleared], ['pairing', [], false]);
      assert.deepEqual(problems, [`the browser did not open PAM's tab. Open this address yourself, in this browser, and PAM pairs with this page: ${web.link}`]);
      browser.visit(web.link);
      assert.equal((await pending).web.state, 'connected');
    }
  });

  test('web: { room } pairs with the PAM page that listens under the code: one offer, whole, and one channel', async () => {
    const pam = browser.arm(ROOM);
    const status = await out.pamsetup({ web: { room: ROOM } });
    assert.deepEqual([status.web.state, status.web.via, status.web.room, status.web.link], ['connected', 'channel', ROOM, undefined]);
    assert.deepEqual(status.problems, []);
    assert.deepEqual(browser.opened, [], 'PAM is open already: no tab is opened');
    const [mine] = browser.rtc.made;
    assert.equal(mine.config, undefined, 'no ICE server is named: the two tabs are on one computer');
    assert.deepEqual([mine.channel.label, mine.channel.options], ['pam-play-v1', undefined], 'one channel, ordered and reliable as a channel is unless told otherwise');
    assert.equal(mine.iceGatheringState, 'complete');
    assert.deepEqual(pairingRequests(), [
      ['PUT', `/api/play/v1/rooms/${ROOM}/offer`, { sdp: mine.localDescription.sdp }],
      ['GET', `/api/play/v1/rooms/${ROOM}/answer?wait=15`],
    ], "the endpoint does the waiting: it is asked once, and holds the request until PAM's answer is there");
    assert.equal(pam.offerOrigin, 'https://sequencer.example');
    assert.deepEqual(pam.kinds(), ['hello', 'getTransport', 'getTransport', 'getTransport'], 'hello goes when the channel opens: there is no ready to wait for');
    assert.equal(pam.addressedTo.size, 0, 'nothing went by postMessage');
    await play(s('1').pam());
    assert.deepEqual(pam.played, [{ type: 'note', time: at(250), cell: 1, velocity: 0.9, duration: 1000 }]);
  });

  test('a room code is 16 random bytes in base64url: 22 characters that are safe in an address', () => {
    assert.equal(makeRoom({ getRandomValues: (bytes) => bytes.fill(0) }), 'A'.repeat(22));
    assert.equal(makeRoom({ getRandomValues: (bytes) => bytes.fill(255) }), `${'_'.repeat(21)}w`, 'every one of the 128 bits is in it: 21 sixes and a two');
    assert.equal(makeRoom({ getRandomValues: (bytes) => bytes.fill(0xfb) }), `${'-_v7'.repeat(5)}-w`, '+ and / are written - and _, and there is no padding');
    const [one, two] = [makeRoom(), makeRoom()];
    assert.match(one, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(one, two);
    assert.equal(isRoom(one), true);
    assert.deepEqual(['short', 'a'.repeat(65), `${'a'.repeat(21)}/`, 5].map(isRoom), [false, false, false, false]);
  });

  test('web: true from a page that is kept apart makes a code, opens PAM under it before anything else, and pairs', async () => {
    keptApart();
    const pending = out.pamsetup({ web: true, preset: 'cold-rail' });
    const code = out.pamstatus().web.room;
    const link = `https://map.audio/pam/play?preset=cold-rail#room=${code}`;
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(browser.opened, [[link, 'pam-play']], 'the tab is opened inside the call, while the key press that started it still counts');
    assert.deepEqual(pairingRequests(), [], 'and the offer is left after it');
    const status = await pending;
    assert.deepEqual([status.web.state, status.web.via, status.web.room, status.web.link], ['connected', 'channel', code, link]);
    assert.deepEqual(status.problems, []);
    assert.equal(status.web.welcome.preset, 'cold-rail');
    assert.equal(browser.pages[0].messages('loadPreset').length, 0, 'PAM started with the preset in its address');
    assert.equal(pairingRequests()[1][1], `/api/play/v1/rooms/${code}/answer?wait=20`, 'a PAM that has to load first is given two minutes, twenty seconds at a time');
  });

  test("a page learns from its own headers that it is kept apart, also where the browser does not say so: the first evaluation pairs, and one tab is opened", async () => {
    // strudel.cc in a browser that does not count it as isolated, and still cuts it off from the tabs it opens.
    browser.page.coop = 'same-origin';
    browser.cutsOpener = true;
    const status = await out.pamsetup({ web: true });
    assert.deepEqual([status.web.state, status.web.via], ['connected', 'channel']);
    assert.deepEqual(browser.opened, [[status.web.link, 'pam-play']], 'no tab was opened that could not answer');
    assert.deepEqual(status.problems, []);
    assert.deepEqual(browser.pageRequests, [['HEAD', 'https://sequencer.example/play']], 'the page is asked for its own address, without what follows the #');
  });

  test("the page's own address is asked for once in a page load, by the first setup that has a tab to open", async () => {
    await settle();
    assert.deepEqual(browser.pageRequests, [], 'loading the module asks for nothing');
    await out.pamsetup({ web: true });
    assert.equal(browser.pageRequests.length, 1);
    browser.pages.at(-1).close();
    const again = out.pamsetup({ web: true });
    assert.equal(browser.opened.length, 2, 'with the answer known, the tab is opened inside the call');
    await again;
    browser.pages.at(-1).close();
    browser.pam.origin = 'https://staging.map.audio';
    await out.pamsetup({ web: 'https://staging.map.audio' });
    assert.deepEqual([browser.opened.length, browser.pageRequests.length], [3, 1], 'three tabs were opened, and the headers were read for the first');
  });

  test('playing over MIDI, pairing under a code that PAM gave, and a page that the browser says is kept apart ask for nothing', async () => {
    const bytes = [];
    await out.pamsetup({ output: { send: (message) => bytes.push([...message]) } });
    await play(s('1').pam());
    assert.equal(bytes.length, 2);
    assert.deepEqual([browser.pageRequests, browser.requests], [[], []], 'MIDI makes no request at all');

    browser.arm(ROOM);
    assert.equal((await out.pamsetup({ web: { room: ROOM } })).web.state, 'connected');
    assert.deepEqual(browser.pageRequests, [], 'a code needs no tab, so the headers do not matter');

    keptApart();
    assert.equal((await out.pamsetup({ web: true })).web.via, 'channel');
    assert.deepEqual(browser.pageRequests, [], 'the browser has said it already');
  });

  test('any opener policy but unsafe-none counts as kept apart, and unsafe-none and no header do not', async () => {
    const via = async (coop) => {
      browser = createBrowser();
      browser.page.coop = coop;
      load();
      const status = await out.pamsetup({ web: true });
      browser.close();
      return status.web.via;
    };
    const policies = ['same-origin', undefined, 'same-origin-allow-popups', 'unsafe-none', 'noopener-allow-popups', ' Unsafe-None ; report-to="coop"', 'Same-Origin; report-to="coop"'];
    const found = [];
    for (const coop of policies) found.push(await via(coop));
    assert.deepEqual(found, ['channel', 'tab', 'channel', 'tab', 'channel', 'tab', 'channel']);
  });

  test('a page that cannot learn its own headers pairs under a code, which works either way: the request failing, an error page, no address to ask', async () => {
    for (const page of [{ reachable: false }, { status: 500 }, { status: 405 }]) {
      browser.close();
      browser = createBrowser();
      Object.assign(browser.page, page);
      load();
      const pending = out.pamsetup({ web: true });
      await settle();
      assert.equal(browser.opened.length, 1, 'it does not wait once the request has failed');
      const status = await pending;
      assert.deepEqual([status.web.state, status.web.via], ['connected', 'channel'], JSON.stringify(page));
      assert.equal(browser.pageRequests.length, 1);
    }

    const nowhere = createBrowser();
    delete nowhere.env.location;
    out = createOutput(strudelCore, nowhere.env, HOME);
    assert.equal((await out.pamsetup({ web: true })).web.via, 'channel');
    assert.deepEqual(nowhere.pageRequests, [], 'with no address of its own there is nothing to ask');
    nowhere.close();
  });

  test('the headers are waited for under a second: an answer in that time decides, and it opens the tab itself', async () => {
    vi.useFakeTimers();
    browser.page.delayMs = 300;
    const pending = out.pamsetup({ web: true });
    await tick(290);
    assert.deepEqual([out.pamstatus().web.state, browser.opened.length], ['checking', 0]);
    await tick(20);
    assert.deepEqual(browser.opened, [['', 'pam-play']], 'no header, so a tab for postMessage, at the moment the answer came');
    vi.useRealTimers();
    assert.equal((await pending).web.via, 'tab');
  });

  test('headers that take longer than the wait are not waited for: the page pairs under a code, and a late answer changes nothing', async () => {
    vi.useFakeTimers();
    browser.page.delayMs = 5000;
    const pending = out.pamsetup({ web: true });
    await tick(790);
    assert.deepEqual([out.pamstatus().web.state, browser.opened.length], ['checking', 0]);
    await tick(20);
    const { link } = out.pamstatus().web;
    assert.deepEqual(browser.opened, [[link, 'pam-play']], 'after 800 ms the tab is opened under a code');
    const status = await pending;
    assert.deepEqual([status.web.state, status.web.via], ['connected', 'channel']);
    await tick(5000);
    assert.deepEqual([out.pamstatus().web.state, browser.opened.length, browser.pageRequests.length], ['connected', 1, 1]);
  });

  test('a setup that goes back to MIDI while PAM is still being reached gives up reaching it: no tab is opened, and no pairing goes on', async () => {
    vi.useFakeTimers();
    browser.page.delayMs = 300;
    out.pamsetup({ web: true });
    await tick(100);
    assert.equal(out.pamstatus().web.state, 'checking');
    await out.pamsetup({ output: { send() {} } });
    await tick(2000);
    assert.deepEqual(browser.opened, [], 'the answer came, and there was nobody left to open a tab for');

    out.pamsetup({ web: { room: ROOM } });
    await tick(100);
    assert.equal(out.pamstatus().web.state, 'pairing');
    await out.pamsetup({ output: { send() {} } });
    browser.arm(ROOM);
    await tick(1000);
    assert.equal(browser.pages[0].kinds().length, 0, 'a PAM that turns up under the code afterwards is not greeted');
    assert.equal(browser.rtc.made[0].connectionState, 'closed');
  });

  test('an evaluation that comes while the headers are waited for takes over the wait: one request, one tab, and it is the newer PAM', async () => {
    vi.useFakeTimers();
    browser.page.delayMs = 300;
    let first = false;
    out.pamsetup({ web: true }).then(() => (first = true));
    await tick(100);
    browser.pam.origin = 'https://staging.map.audio';
    const second = out.pamsetup({ web: 'https://staging.map.audio' });
    await tick(300);
    vi.useRealTimers();
    const status = await second;
    await settle();
    assert.deepEqual([status.web.state, status.web.page], ['connected', 'https://staging.map.audio/pam/play']);
    assert.deepEqual([browser.opened.length, browser.pageRequests.length, first], [1, 1, false]);
    assert.equal(browser.pages[0].address, 'https://staging.map.audio/pam/play');
  });

  test('where the browser will not open the tab, the address is shown and the pairing waits for it to be opened by hand', async () => {
    keptApart();
    browser.blocked = true;
    const pending = out.pamsetup({ web: true });
    await settle();
    const { web, problems } = out.pamstatus();
    assert.equal(web.state, 'pairing');
    assert.equal(web.link, `https://map.audio/pam/play#room=${web.room}`);
    assert.deepEqual(browser.opened, [[web.link, 'pam-play']], 'the browser was asked once, and its no is taken');
    assert.deepEqual(problems, [`the browser did not open PAM's tab. Open this address yourself, in this browser, and PAM pairs with this page: ${web.link}`]);
    browser.visit(web.link);
    assert.equal((await pending).web.state, 'connected');
  });

  test('where neither the browser nor the headers say that the page is kept apart, the tab that went out of reach shows it, and the next evaluation pairs under a code', async () => {
    browser.cutsOpener = true;
    out.pamsetup({ web: true });
    await settle();
    assert.equal(out.pamstatus().web.state, 'opening');
    assert.deepEqual(browser.opened, [['', 'pam-play']]);
    assert.equal(browser.pageRequests.length, 1);
    const status = await out.pamsetup({ web: true });
    assert.match(status.problems.join('\n'), /the PAM tab that this page opened went out of reach before PAM answered\. Unless you closed it, the browser keeps this page apart from tabs of other sites, so from now on this page pairs with PAM under a code instead/);
    assert.deepEqual([status.web.state, status.web.via], ['connected', 'channel']);
    assert.equal(browser.opened[1][0], status.web.link);
  });

  test('an evaluation uses the channel that is open: nothing is asked of PAM\'s site again', async () => {
    browser.arm(ROOM);
    await out.pamsetup({ web: { room: ROOM } });
    const [peers, asked] = [browser.rtc.made.length, browser.requests.length];
    const again = await out.pamsetup({ web: { room: ROOM }, names: { bd: 1 } });
    assert.equal(again.web.state, 'connected');
    assert.deepEqual([browser.rtc.made.length, browser.requests.length], [peers, asked]);
  });

  test('a PAM tab that was loaded again closes the channel, and the next evaluation pairs again under the same code', async () => {
    const pam = browser.arm(ROOM);
    await out.pamsetup({ web: { room: ROOM } });
    pam.reload();
    await settle();
    let status = out.pamstatus();
    assert.equal(status.web.state, 'closed');
    assert.match(status.problems.join('\n'), /the way to PAM has closed: its tab was closed or loaded again\. Evaluate again to reach it again/);
    await play(s('1').pam());
    assert.equal(out.pamstatus().dropped, 1);

    status = await out.pamsetup({ web: { room: ROOM } });
    assert.deepEqual([status.web.state, status.web.room], ['connected', ROOM]);
    assert.equal(browser.rtc.made.length, 4, 'a new connection on each side');
    assert.equal(browser.rtc.made[0].connectionState, 'closed', 'the old one is closed first');
    await play(s('1').pam());
    assert.equal(pam.played.length, 1);
  });

  test('under its own code the page gives a PAM that may only have been loaded again three seconds, then opens PAM again', async () => {
    vi.useFakeTimers();
    keptApart();
    const first = await out.pamsetup({ web: true });
    browser.pages[0].close();
    await tick();
    assert.equal(out.pamstatus().web.state, 'closed');

    const pending = out.pamsetup({ web: true });
    await tick(2900);
    assert.equal(browser.opened.length, 1);
    assert.equal(out.pamstatus().web.state, 'pairing');
    await tick(200);
    assert.deepEqual(browser.opened[1], [first.web.link, 'pam-play'], 'the same code: PAM is opened under it again');
    const status = await pending;
    assert.deepEqual([status.web.state, status.web.room], ['connected', first.web.room]);
  });

  test('a code that no PAM listens under is given fifteen seconds, and then it is said what to do', async () => {
    vi.useFakeTimers();
    const pending = out.pamsetup({ web: { room: ROOM } });
    await tick(14900);
    assert.equal(out.pamstatus().web.state, 'pairing');
    await tick(200);
    const status = await pending;
    assert.equal(status.web.state, 'unpaired');
    assert.deepEqual(status.problems, [`no PAM answered under the code ${ROOM} within 15 seconds: the PAM page that gave it was closed, or has stopped listening. Get a new line from PAM's page`]);
    assert.equal(browser.rtc.made[0].connectionState, 'closed', 'the connection that was being made is let go');
    vi.useRealTimers();
    await play(s('1').pam());
    assert.equal(out.pamstatus().dropped, 1);
  });

  test('a browser that never finishes gathering its addresses is given five seconds, and nothing is left at PAM\'s site', async () => {
    vi.useFakeTimers();
    browser.arm(ROOM);
    browser.rtc.gathers = false;
    const pending = out.pamsetup({ web: { room: ROOM } });
    await tick(5100);
    const status = await pending;
    assert.equal(status.web.state, 'unpaired');
    assert.match(status.problems.join('\n'), /the browser did not finish preparing a connection within 5 seconds: it found no network address to give PAM\. Check that this browser is allowed to use WebRTC/);
    assert.deepEqual(pairingRequests(), []);
  });

  const NO_CONNECTION = "PAM answered, but the browser or the network did not let the two tabs connect directly, and they talk straight to each other over this computer's own network, with no relay. On a Mac, the browser needs Local Network access (System Settings > Privacy & Security > Local Network). A firewall, a VPN, a privacy extension or a browser setting that blocks local WebRTC or multicast also stops it";

  test('a connection that the browser or the network blocks is said to be that, with what to look at', async () => {
    browser.arm(ROOM);
    browser.rtc.blocked = true;
    const status = await out.pamsetup({ web: { room: ROOM } });
    assert.equal(status.web.state, 'unpaired');
    assert.deepEqual(status.problems, [NO_CONNECTION]);
  });

  test("a connection that never says anything, as when the other tab's .local names are not found, is given fifteen seconds after PAM's answer", async () => {
    vi.useFakeTimers();
    browser.arm(ROOM);
    browser.rtc.unresolved = true;
    const pending = out.pamsetup({ web: { room: ROOM } });
    await tick(14900);
    assert.equal(out.pamstatus().web.state, 'pairing');
    assert.equal(browser.rtc.made[0].iceConnectionState ?? 'new', 'new', 'nothing was ever said');
    await tick(200);
    const status = await pending;
    assert.deepEqual([status.web.state, status.problems], ['unpaired', [NO_CONNECTION]]);
    assert.equal(browser.rtc.made[0].connectionState, 'closed');
  });

  test("an answer from an earlier pairing that is still at PAM's site is not taken for the answer to a new offer", async () => {
    const pam = browser.arm(ROOM);
    await out.pamsetup({ web: { room: ROOM } });
    pam.close();
    await settle();
    // Reading does not remove an entry, so the first answer is still there until a new offer removes it.
    const pending = out.pamsetup({ web: { room: ROOM } });
    await settle();
    assert.equal(out.pamstatus().web.state, 'pairing', 'the old answer was not taken');
    browser.arm(ROOM);
    const status = await pending;
    assert.deepEqual([status.web.state, browser.rtc.made.at(-1).remoteDescription.type], ['connected', 'offer']);
    assert.equal(browser.rtc.made.at(-2).remoteDescription.sdp, `stand-in ${browser.rtc.made.at(-1).id}`, "the sender's new connection was answered by the new PAM page");
  });

  test("PAM's site refusing the pairing, being out of reach, and a browser with no WebRTC each say what happened", async () => {
    browser.site.refuses = [404, 'not_found'];
    let status = await out.pamsetup({ web: { room: ROOM } });
    assert.equal(status.web.state, 'unpaired');
    assert.deepEqual(status.problems, ["PAM's site did not take the pairing (it answered 404 not_found): https://map.audio may be out of reach, or not a site that serves PAM"]);

    browser.site.refuses = [503, 'pairing_off'];
    status = await out.pamsetup({ web: { room: OTHER_ROOM } });
    assert.deepEqual([status.web.state, status.problems], ['unpaired', ["https://map.audio does not pair tabs, so no PAM can be reached there from this page. Name the site that serves PAM: pamsetup({ web: 'https://map.audio' })"]]);
    browser.site.refuses = undefined;

    browser.site = { reachable: false };
    status = await out.pamsetup({ web: { room: OTHER_ROOM } });
    assert.deepEqual(status.problems, ["PAM's site did not take the pairing (Failed to fetch): https://map.audio may be out of reach, or not a site that serves PAM"]);

    delete browser.env.RTCPeerConnection;
    status = await out.pamsetup({ web: { room: ROOM } });
    assert.deepEqual([status.web.state, status.problems], ['unpaired', ['this browser has no WebRTC, which is how this page would reach a PAM tab']]);
  });

  test("a description longer than PAM's site takes is not sent, and it is said why", async () => {
    browser.arm(ROOM);
    browser.rtc.sdpBytes = 9000;
    const status = await out.pamsetup({ web: { room: ROOM } });
    assert.equal(status.web.state, 'unpaired');
    assert.deepEqual(status.problems, ["this browser's description of the connection is 9010 bytes, and PAM's site takes 8000, so it cannot be handed over. It lists every network address of this computer, and a computer with many network adapters or VPNs lists more than PAM's site takes"]);
    assert.deepEqual(pairingRequests(), [], 'nothing was sent');
    browser.rtc.sdpBytes = 7900;
    assert.equal((await out.pamsetup({ web: { room: ROOM } })).web.state, 'connected', 'one that fits goes through');
  });

  test("when PAM's site says to wait, the pairing waits that long and asks again, and gives up if the wait is longer than it has", async () => {
    vi.useFakeTimers();
    browser.arm(ROOM);
    browser.site.busy = { times: 2, retryAfter: 3 };
    const pending = out.pamsetup({ web: { room: ROOM } });
    await tick(2900);
    assert.deepEqual(pairingRequests().map(([method]) => method), ['PUT'], 'the offer was refused with a 429, and is not sent again before the three seconds are over');
    await tick(200);
    assert.deepEqual(pairingRequests().map(([method]) => method), ['PUT', 'PUT'], 'the second try is told to wait as well');
    await tick(3000);
    assert.equal((await pending).web.state, 'connected');
    assert.deepEqual(pairingRequests().map(([method]) => method), ['PUT', 'PUT', 'PUT', 'GET']);

    browser.pages[0].close();
    browser.arm(OTHER_ROOM);
    browser.site.busy = { times: 1 }; // a 429 that names no wait is given a second
    const second = out.pamsetup({ web: { room: OTHER_ROOM } });
    await tick(900);
    assert.equal(out.pamstatus().web.state, 'pairing');
    await tick(200);
    assert.equal((await second).web.state, 'connected');

    browser.site.busy = { times: 1, retryAfter: 60 };
    const status = await out.pamsetup({ web: { room: ROOM } });
    assert.equal(status.web.state, 'unpaired');
    assert.deepEqual(status.problems, ["PAM's site asked for a wait of 60 s, longer than the pairing can wait: evaluate again in a moment"]);
  });

  test('a tick that would make one message longer than PAM takes on a channel goes as shorter ones', async () => {
    browser.pam.limits.eventsPerMessage = 5000;
    const pam = browser.arm(ROOM);
    await out.pamsetup({ web: { room: ROOM } });
    // 2400 notes at once are about 250,000 bytes of JSON, and PAM ignores a frame over 200,000.
    await play(s('1*2400').pam());
    assert.equal(pam.ignored, 0);
    assert.deepEqual(pam.messages('events').map((message) => message.events.length), [1200, 1200]);
    assert.deepEqual([pam.played.length, out.pamstatus().web.accepted], [2400, 2400]);
  });

  test('a pairing that another PAM overtakes is let go, and one that is evaluated again while it waits goes on as one', async () => {
    let first = false;
    out.pamsetup({ web: { room: ROOM } }).then(() => (first = true));
    await settle();
    out.pamsetup({ web: { room: ROOM } });
    await settle();
    assert.equal(pairingRequests().filter(([method]) => method === 'PUT').length, 1, 'the same code again: the pairing under way is the one');

    browser.arm(OTHER_ROOM);
    const status = await out.pamsetup({ web: { room: OTHER_ROOM } });
    assert.deepEqual([status.web.state, status.web.room], ['connected', OTHER_ROOM]);
    assert.equal(browser.rtc.made[0].connectionState, 'closed');
    // A PAM that turns up under the first code finds the offer that was left, and nobody takes its answer.
    browser.arm(ROOM);
    await settle();
    assert.equal(first, false);
    assert.deepEqual([out.pamstatus().web.state, out.pamstatus().web.room], ['connected', OTHER_ROOM]);
  });

  test("pair, used on its own, says that it was stopped, which is not a failure of PAM's site", async () => {
    const stop = new AbortController();
    const signalling = createSignalling({ origin: PAM_ORIGIN, fetch: browser.fetch });
    const pending = pair({ env: browser.env, signalling, room: ROOM, label: CHANNEL, answerWaitMs: 15000, signal: stop.signal });
    await settle();
    stop.abort();
    await assert.rejects(pending, (err) => err instanceof PairError && err.code === 'overtaken');
    assert.equal(browser.rtc.made[0].connectionState, 'closed');
  });

  test('what arrives on the channel and is not a message of the interface is ignored, and a channel that PAM closes ends the sending', async () => {
    const pam = browser.arm(ROOM);
    await out.pamsetup({ web: { room: ROOM } });
    pam.sendRaw('not JSON');
    pam.sendRaw(JSON.stringify({ channel: 'pam-learn-v1', kind: 'status', connected: false }));
    pam.sendRaw(JSON.stringify(null));
    await settle();
    assert.equal(out.pamstatus().web.state, 'connected');
    pam.close();
    await settle();
    assert.equal(out.pamstatus().web.state, 'closed');
  });
});
