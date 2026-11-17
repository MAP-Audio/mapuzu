/*
index.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `@mapaudio/mapuzu/tidal`: the TidalCycles binding. Tidal itself is Haskell, so what lives here is
// the other end of its OSC target: reading the messages, and writing the boot script that sends them.

export { decodePacket, encodeMessage, encodeBundle, timetagToMs } from './osc.mjs';
export { createTidalReceiver, tidalValue, parseSetup, TIDAL_ADDRESS, TIDAL_MARK, KNOB_PREFIX, TIDAL_NOTE_ZERO } from './receiver.mjs';
export { bootFile, tidalParams, tidalWord, TIDAL_PORT, TIDAL_LATENCY, TIDAL_BOOT, bootLines, TIDAL_WORDS } from './boot.mjs';
export { createPort } from './page.mjs';
