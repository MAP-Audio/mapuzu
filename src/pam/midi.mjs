/*
midi.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// PAM events -> MIDI bytes. The bytes are the whole contract with a running PAM, so this module
// knows no transport: it returns messages with a time offset from the event's onset, and whoever
// holds a MIDI output sends them.

import { toMidi7 } from './params.mjs';
import { createSetup, actionTarget, paramNumber, PAM_ACTIONS } from './midimap.mjs';
import { heldLength, midiVelocity, resolveNote } from './events.mjs';

/**
 * @typedef {object} MidiMessage
 * @property {number[]} bytes
 * @property {number} at seconds from the event's onset: 0, the note's length, or a lead before it
 */

const status = (kind, channel) => kind | ((channel - 1) & 0x0f);
const sendChannel = (channel) => (channel === 0 ? 1 : channel);

/** The three controllers of one 7-bit NRPN write, in the order that JUCE's detector expects. */
export function nrpnBytes(channel, number, value) {
  const s = status(0xb0, channel);
  return [
    [s, 99, (number >> 7) & 0x7f],
    [s, 98, number & 0x7f],
    [s, 6, value & 0x7f],
  ];
}

/**
 * Makes an encoder for one PAM. It remembers the last value it sent each knob (to stay quiet when a
 * pattern repeats itself) and which cells it muted and soloed, since PAM's MIDI can only toggle them.
 * A variation or preset switch empties both memories, because PAM then holds what that variation or
 * preset stores, which is taken to be no mutes and no solos.
 *
 * @param {import('./midimap.mjs').PamSetup} [setup]
 * @param {object} [options]
 * @param {number} [options.noteOffGap] seconds a note ends before its event does, so a repeat retriggers (default 0.01)
 * @param {number} [options.variationLead] seconds a variation switch is sent ahead of its onset. PAM
 *   makes a switch on the next bar line, so the switch has to arrive before the bar line it is meant
 *   for, and with room to spare: when switches were sent 60 ms ahead, a running PAM made half of
 *   them a bar late (default 0.2)
 * @param {boolean} [options.dedupe] skip a knob whose MIDI value did not change (default true)
 */
export function createMidiEncoder(initialSetup = createSetup(), options = {}) {
  const { noteOffGap = 0.01, variationLead = 0.2, dedupe = true } = options;
  let setup = initialSetup;
  const lastKnob = new Map();
  const switches = new Map();

  // A fixed listener hears a program change unless the player gave it a controller.
  const select = (listener, value) => {
    const channel = sendChannel(listener.channel);
    return listener.cc === undefined || listener.cc === null ? [status(0xc0, channel), value] : [status(0xb0, channel), listener.cc, value];
  };

  const pressBytes = (name, cell, arg) => {
    const def = PAM_ACTIONS[name];
    if (def.listener) {
      const listener = setup.listeners[def.listener];
      const base = def.code ?? 0;
      const value = def.listener === 'resample' ? cell : def.track ? base + arg - 1 : base;
      return [[status(0xb0, sendChannel(listener.channel)), listener.cc, value]];
    }
    const target = actionTarget(name, cell);
    return nrpnBytes(setup.control, target.number, 127);
  };

  /**
   * @param {import('./events.mjs').PamEvent[]} events one pattern event's worth, from `compileValue`
   * @param {number} [duration] the event's length in seconds, for its note-off
   * @returns {MidiMessage[]} in sending order
   */
  function encode(events, duration = 0) {
    const out = [];
    const now = (bytes) => out.push({ bytes, at: 0 });
    const notes = [];
    // PAM answers a variation or preset switch by bringing back what that one stores, knob values
    // and mutes included. So the switch goes first, and what it took back is sent again after it.
    const recalls = (event) => event.type === 'variation' || event.type === 'preset';
    const recalled = () => {
      lastKnob.clear();
      switches.clear();
    };
    for (const event of [...events.filter(recalls), ...events.filter((e) => !recalls(e))]) {
      switch (event.type) {
        case 'knob': {
          const value = toMidi7(event.param, event.value);
          if (dedupe && lastKnob.get(event.param.id) === value) break;
          lastKnob.set(event.param.id, value);
          const own = setup.cc[event.param.id];
          if (own) now([status(0xb0, own.channel), own.cc, value]);
          else nrpnBytes(setup.control, paramNumber(event.param), value).forEach(now);
          break;
        }
        case 'switch': {
          const key = `${event.what}:${event.cell}`;
          if ((switches.get(key) ?? false) === event.on) break;
          switches.set(key, event.on);
          pressBytes(event.what, event.cell).forEach(now);
          break;
        }
        case 'press': {
          if (event.name === 'mute' || event.name === 'solo') {
            const key = `${event.name}:${event.cell}`;
            switches.set(key, !(switches.get(key) ?? false));
          }
          pressBytes(event.name, event.cell, event.arg).forEach(now);
          break;
        }
        case 'variation':
          out.push({ bytes: select(setup.listeners.variation, event.index - 1), at: -variationLead });
          recalled();
          break;
        case 'preset':
          now(select(setup.listeners.preset, event.index));
          recalled();
          break;
        case 'transport':
          now([{ start: 0xfa, continue: 0xfb, stop: 0xfc, clock: 0xf8 }[event.command]]);
          break;
        case 'cc':
          now([status(0xb0, event.channel), event.cc, event.value]);
          break;
        case 'nrpn':
          nrpnBytes(event.channel, event.number, event.value).forEach(now);
          break;
        case 'note':
          notes.push(event);
          break;
      }
    }
    // Notes go last, so that everything set by a note's own event is in place when the note starts.
    for (const event of notes) {
      const cell = setup.cells[event.cell - 1];
      const note = resolveNote(event, cell);
      out.push({ bytes: [status(0x90, cell.channel), note, midiVelocity(event.velocity)], at: 0 });
      out.push({ bytes: [status(0x80, cell.channel), note, 0], at: Math.max(heldLength(duration, noteOffGap), 0) });
    }
    return out;
  }

  return {
    encode,
    /** Forget the knob values sent, so that the next value for each id is sent. Mutes and solos stay, because PAM keeps them. */
    forget() {
      lastKnob.clear();
    },
    /** Forget everything: knob values, and every cell counts as unmuted and unsoloed. */
    reset() {
      lastKnob.clear();
      switches.clear();
    },
    /** Tell the encoder what PAM already holds, after muting or soloing by hand: `assume('mute', 3, true)`. */
    assume(what, cell, on) {
      switches.set(`${what}:${cell}`, Boolean(on));
    },
    /** Change the wiring and keep what was sent: a setup that is declared again must not unmute anything. */
    use(next) {
      setup = next;
    },
    get setup() {
      return setup;
    },
  };
}
