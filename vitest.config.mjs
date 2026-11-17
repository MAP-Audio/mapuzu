/*
vitest.config.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    // The published @strudel/core imports a named export from @kabelsalat/web that the package's
    // CommonJS main does not have. Nothing here uses it, so tests load the same stub that the CLI does.
    alias: { '@kabelsalat/web': fileURLToPath(new URL('./src/node/kabelsalat-stub.mjs', import.meta.url)) },
    server: { deps: { inline: [/@strudel\//] } },
  },
});
