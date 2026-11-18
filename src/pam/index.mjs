/*
index.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `@mapaudio/mapuzu/pam`: the engine side. It imports no pattern language, so a Tidal or any other
// binding builds on the same value maps, MIDI map and freezer as the Strudel one.

export {
  PAM_PRODUCT,
  PAM_PARAMETER_VERSION,
  PAM_CELLS,
  PAM_VARIATIONS,
  PAM_HOSTED_PER_CELL,
  PAM_DRUM_SYNTH_ENGINES,
  PAM_DRUM_SYNTH_NOTES,
  resolveParam,
  isCellParamName,
  listParams,
  cellParamNames,
  parseParamValue,
  toNormalized,
  fromNormalized,
  toMidi7,
  fromMidi7,
} from './params.mjs';

export {
  PAM_DEFAULT_NOTE,
  PAM_DEFAULT_ROOT,
  PAM_LISTENERS,
  PAM_AUTOMAP,
  PAM_ACTIONS,
  createSetup,
  setupFromState,
  paramNumber,
  parseAction,
  actionTarget,
  mappingRows,
} from './midimap.mjs';

export { compileValue, resolveNote, noteNumber } from './events.mjs';
export { createMidiEncoder, nrpnBytes } from './midi.mjs';
export { createFollower, readSnapshot, CLOCK_FEED_URL, CLOCK_VERSION } from './follow.mjs';
export { PLAY_CHANNEL, PLAY_PROTOCOL, PLAY_PAGE, playTarget, toPlayEvents, checkSetup, createPlayClient } from './play.mjs';
export { createSignalling, makeRoom, pair, PairError } from './play-rtc.mjs';
