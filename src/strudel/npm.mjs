/*
npm.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// The binding for the `@strudel/core` that the project installs: it is a peer dependency, so there
// is one copy. `index.mjs` exports from it, and the Node side and the tests reach `reset` and
// `pamstatus` through it.

import * as core from '@strudel/core';
import { createBinding } from './binding.mjs';

export const binding = createBinding(core);
