/*
index.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `@mapaudio/mapuzu/node`: the side that runs in Node. It evaluates Strudel files outside the
// browser, freezes them into PAM presets and renders them through mapcli. It also serves the
// package to a page that already runs Strudel, and listens for TidalCycles. The `mapuzu` command is
// a thin wrapper over it.

export { freeze, songFor, patternClock, PAM_MAX_PATTERN_BEATS, PAM_SLOW_SPEEDS, PAM_LANES_PER_CELL } from '../pam/freeze.mjs';
export { loadStrudel, evaluateStrudel, collect } from './strudel.mjs';
export { readPreset, decodeVariation, variationStates, currentSlot, laneTargets } from './preset.mjs';
export { mapcli, mapcliPath, MapcliError } from './mapcli.mjs';
export { freezeSong, renderSong, encodeMp3, songTags } from './render.mjs';
export { buildKit } from './kit.mjs';
export { patternToSequences, sequencesToStrudel, presetToStrudel } from './convert.mjs';
export { serve, SERVE_PORT } from './serve.mjs';
export { createFakeClock, serveClock, CLOCK_PORT } from './fake-clock.mjs';
export { tidal, TIDAL_PAGE } from './tidal.mjs';
