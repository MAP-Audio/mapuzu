/*
kabelsalat-hook.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Node module-resolution hook: sends `@kabelsalat/web` to the stub beside this file, so that the
// published @strudel/core loads outside a bundler. See kabelsalat-stub.mjs for why.

const stub = new URL('./kabelsalat-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@kabelsalat/web') return { url: stub, shortCircuit: true };
  return nextResolve(specifier, context);
}
