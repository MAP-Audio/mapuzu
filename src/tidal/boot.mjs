/*
boot.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Writes mapaudio.tidal: the TidalCycles side, a boot script that defines PAM as an OSC target and
// the vocabulary that plays it. The target and the handful of words are written out here. The
// section with one word per parameter is made from the same parameter table that everything else
// reads, so it cannot name a parameter that PAM does not have, or miss one that it has.

import { PAM_PARAMETER_VERSION, cellParamNames, listParams, resolveParam } from '../pam/params.mjs';
import { KNOB_PREFIX, TIDAL_ADDRESS, TIDAL_MARK } from './receiver.mjs';

/** The UDP port `mapuzu tidal` listens on and `pamTarget` sends to. */
export const TIDAL_PORT = 4748;
/**
 * Seconds Tidal sends each event ahead of its time. A variation switch has to reach PAM 200 ms
 * before its bar line, so this has to be longer than that.
 */
export const TIDAL_LATENCY = 0.3;

/**
 * What goes in BootTidal.hs to start Tidal with PAM beside SuperDirt, for each Tidal version: the
 * stock file's own line that starts the stream (`replaces`), and that line with its target and
 * settings kept and `pamOscMap` added (`stream`). Read from Tidal's source at v1.9.5 and v1.10.3.
 */
export const TIDAL_BOOT = Object.freeze([
  Object.freeze({ tidal: '1.10', replaces: 'tidalInst <- mkTidal', stream: 'tidalInst <- mkTidalWith (mkOscMap ++ [pamOscMap]) defaultConfig' }),
  Object.freeze({ tidal: '1.9', replaces: 'tidal <- startTidal ...', stream: 'tidal <- startStream (defaultConfig {cVerbose = True, cFrameTimespan = 1/20}) [(superdirtTarget {oLatency = 0.05, oAddress = "127.0.0.1", oPort = 57120}, [superdirtShape]), pamOscMap]' }),
]);

/** The lines to put in BootTidal.hs for each Tidal version, as text: `path` is where mapaudio.tidal is. */
export function bootLines(path, indent = '') {
  return TIDAL_BOOT.map(({ tidal, replaces, stream }) =>
    [`Tidal ${tidal}, in place of the line that says  ${replaces}`, '', `  :script ${path}`, `  ${stream}`].map((line) => (line ? indent + line : line)).join('\n'),
  ).join('\n\n');
}

const LICENSE = `-- mapaudio.tidal - part of @mapaudio/mapuzu
-- This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.`;

/** The words that mapaudio.tidal defines by hand, which no parameter's word may repeat. */
export const TIDAL_WORDS = Object.freeze([
  'pamTarget',
  'pamOSCSpecs',
  'pamOscMap',
  'pamto',
  'pam',
  'cell',
  'knob',
  'knobS',
  'variation',
  'vari',
  'pampress',
  'pamsetup',
  'pamclock',
  'pamclockOf',
  'pamstop',
  'pamMute',
  'pamSolo',
]);

/** The word that mapaudio.tidal gives a parameter: `filterCutoff` is `pamFilterCutoff`. */
export const tidalWord = (id) => `pam${id[0].toUpperCase()}${id.slice(1)}`;

/**
 * Every parameter that gets a word: the per-cell names and the global ids, once each, in the
 * table's order. `labels` marks the ones that take a name (`"Gate"`) as well as a number.
 * @returns {{ id: string, word: string, labels: boolean }[]}
 */
export function tidalParams() {
  const seen = new Map();
  for (const name of cellParamNames()) seen.set(name, Boolean(resolveParam(name, 1).labels));
  for (const param of listParams({ cells: [] })) if (!seen.has(param.id)) seen.set(param.id, Boolean(param.labels));
  return [...seen].map(([id, labels]) => ({ id, word: tidalWord(id), labels }));
}

// How many words go in one block: a slip in one block then costs GHCi that block, not all of them.
const WORDS_PER_BLOCK = 80;

/** The text of mapaudio.tidal. */
export function bootFile() {
  const params = tidalParams();
  const width = Math.max(...params.map((p) => p.word.length));
  const lines = params.map((p) => `    ${p.word.padEnd(width)} = ${p.labels ? 'knobS' : 'knob '} "${p.id}"`);
  const blocks = [];
  for (let i = 0; i < lines.length; i += WORDS_PER_BLOCK) blocks.push(`:{\nlet\n${lines.slice(i, i + WORDS_PER_BLOCK).join('\n')}\n:}`);
  return `${LICENSE}

-- MAP Audio's instruments as TidalCycles OSC targets. Today that is PAM.
--
-- Tidal sends each event here as one OSC message of named arguments, stamped with its time, and
-- \`mapuzu tidal\` (this package's command) turns them into the MIDI that a running PAM answers.
-- So:
--
--   1. run  mapuzu tidal   and open the page it prints, which holds the MIDI port
--   2. load this file before the stream starts, and give the stream pamOscMap, in BootTidal.hs.
--      A Tidal 1.10 boot file in the old style takes the 1.9 lines.
--
${bootLines('/path/to/mapaudio.tidal', '      ').split('\n').map((line) => `--${line}`.trimEnd()).join('\n')}
--
-- The words are the ones that this package gives Strudel (README.md), in Tidal's form:
--
--   d1 $ pam "bd*4"                                            -- cells by name or number: plays them
--   d2 $ note "c3 [ef3 g3]" # pam "acid" # legato 0.55         -- by pitch. note "c5" is middle C
--   d3 $ n "0 3 7" # pam "chop"                                -- by steps above the cell's root: slices
--   d4 $ knob "filterCutoff" "<300 1200 8000>" # cell "3"      -- any parameter, in its own unit
--   d5 $ variation "<1 1 2 3>/4"                               -- PAM's variations, on the bar
--   d6 $ pamclock                                              -- MIDI clock for a standalone PAM
--   once $ pamsetup "channels=cell poly=5 roots=5:36 names=bd:1,acid:5"
--
-- Made by \`mapuzu tidal --boot\` for PAM's parameter version ${PAM_PARAMETER_VERSION}. The last section is written from
-- PAM's parameter table: change src/tidal/boot.mjs, not this file.

-- Target
-- Tidal sends each event ${TIDAL_LATENCY} s ahead of its time, in a bundle stamped with that time. It has to be
-- ahead by more than the 0.2 s that a variation switch is sent before its bar line.
:{
pamTarget = Target {oName      = "PAM",
                    oAddress   = "127.0.0.1",
                    oPort      = ${TIDAL_PORT},
                    oBusPort   = Nothing,
                    oLatency   = ${TIDAL_LATENCY},
                    oWindow    = Nothing,
                    oSchedule  = Pre BundleStamp,
                    oHandshake = False
                   }
:}

-- OSC Specs
-- One message for everything: PAM has more parameters than a list of arguments can hold, so they
-- go by name. Only an event that carries "${TIDAL_MARK}" is sent, and every word below adds it, so
-- nothing meant for SuperDirt reaches PAM. Nothing here has an "s", so SuperDirt plays none of it.
:{
pamOSCSpecs = [OSC "${TIDAL_ADDRESS}" $ Named {requiredArgs = ["${TIDAL_MARK}"]}]
:}

-- OSC Map
pamOscMap = (pamTarget, pamOSCSpecs)

-- Parameters
-- pamto         what sends an event to PAM. Add it to plain MIDI: once $ progNum 3 # pamto
--               (progNum, midicmd, ccn and ccv, nrpnn and nrpnv, midichan, as SuperDirt's MIDI reads them)
-- pam           plays cells, by number or by a name from pamsetup: pam "bd*4", pam "1 ~ 2 ~"
-- cell          the cell a note, knob or press is for: cell "3", cell "acid". On its own it plays nothing
-- knob          any parameter that a MIDI mapping can reach, by PAM's own id, in its own unit. A
--               per-cell name (filterCutoff, delayMix, synth_p1, mute) goes to the event's cell.
--               A full id (cell3_delayMix, macro_filterCutoff, crossfade, hosted_p3_12) needs none
-- knobS         the same for a parameter that takes names: knobS "mode" "<Trigger Gate Loop>".
--               A name of two words is written as one: "AcousticKick"
-- variation     switches PAM to one of its eight variations. PAM makes the switch on the next bar line
-- pampress      presses a button: mute solo stop trigger (the event's cell), record, looperRecord,
--               looperArmAll, looperDisarmAll, looperClearAll, looperCapture, looperArm:n,
--               looperMute:n, looperSolo:n, looperClear:n, looperVariation:n, resample (into the
--               event's cell). Tidal has a press of its own, which this leaves alone
-- pamsetup      describes the PAM being played, as Strudel's pamsetup({...}) does. Call it with once:
--               channels=cell poly=5,7 roots=5:36 notes=1:36 names=bd:1,hh:3 control=16 cc=automap
--               port=IAC Driver Bus 1 latency=0.02 muted=3 soloed=
-- pamclock      MIDI clock for a standalone PAM with External Clock Sync on: 24 ticks a beat,
--               started at cycle 0 (resetCycles) or joined on the next sixteenth, and stopped
--               when the pattern is hushed. pamclockOf 3 for three beats to the cycle
-- pamstop       all notes off and MIDI stop: once pamstop
-- pamMute       a cell's mute as a level, 0 or 1: pamMute "<0 1>/4" # cell "3". pamSolo likewise
-- Notes take note (c5 is middle C), n, up, midinote and freq; velocity and gain; legato and
-- sustain; and nudge, in seconds, to move a pattern against the others.
:{
let pamto = pI "${TIDAL_MARK}" 1
    pam p = pS "pam" p # pamto
    cell p = pS "cell" p # pamto
    knob name p = pF ("${KNOB_PREFIX}" ++ name) p # pamto
    knobS name p = pS ("${KNOB_PREFIX}" ++ name) p # pamto
    variation p = pI "variation" p # pamto
    vari = variation
    pampress p = pS "press" p # pamto
    pamsetup text = pS "pamsetup" (pure text) # pamto
    pamclockOf beats = fast (pure (24 * beats)) $ pS "midicmd" "midiClock" # pamto
    pamclock = pamclockOf 4
    pamstop = pS "midicmd" "stop" # pamto
    pamMute = knob "mute"
    pamSolo = knob "solo"
:}

-- Parameter shortcuts
-- One word for each of PAM's ${params.length} mappable parameters: pamFilterCutoff "<300 1200>" # cell "3" is
-- knob "filterCutoff" "<300 1200>" # cell "3". A parameter that takes names takes them here:
-- pamMode "<Trigger Gate Loop>" # cell "2", or by number, pamMode "<0 1 2>".
${blocks.join('\n')}
`;
}
