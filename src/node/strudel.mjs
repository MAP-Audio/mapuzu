/*
strudel.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Strudel outside the browser: evaluates a REPL file as the REPL would (mini-notation strings,
// `$:` and named labels, `setcpm`) and queries the pattern it leaves, without playing anything.

import { register } from 'node:module';
import { compileValue } from '../pam/events.mjs';
import { createSetup } from '../pam/midimap.mjs';

let loaded;

// Runs `work` with the named console methods silenced, and puts them back.
async function quietly(methods, work) {
  const saved = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) console[method] = () => {};
  try {
    return await work();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * Loads the published Strudel packages and puts them, with this package, in pattern scope.
 * @returns {Promise<{ core: object, mini: object, transpiler: Function, output: object }>} `output` is this package's binding to that core (src/strudel/npm.mjs)
 */
export function loadStrudel() {
  loaded ??= (async () => {
    register(new URL('./kabelsalat-hook.mjs', import.meta.url));
    // core logs a greeting on import and a note that there is no window. Neither belongs in a tool's output
    const core = await quietly(['log', 'warn'], () => import('@strudel/core'));
    const [mini, tonal, { transpiler }, mapuzu, { binding: output }] = await Promise.all([
      import('@strudel/mini'),
      import('@strudel/tonal'),
      import('@strudel/transpiler'),
      import('../../index.mjs'),
      import('../strudel/npm.mjs'),
    ]);
    await core.evalScope(core, mini, tonal, mapuzu);
    // Drawing and sample loading mean nothing here, but a song that calls them should still evaluate.
    for (const name of ['pianoroll', 'punchcard', 'scope', 'spectrum', 'spiral', 'pitchwheel', 'color']) {
      for (const method of [name, `_${name}`]) core.Pattern.prototype[method] ??= function () { return this; };
    }
    globalThis.samples ??= async () => {};
    return { core, mini, transpiler, output };
  })();
  return loaded;
}

/**
 * Evaluates Strudel REPL code and returns the pattern it plays and its tempo.
 *
 * @param {string} code
 * @returns {Promise<{ pattern: object, cps: number }>} `cps` is cycles per second as the code set it (0.5 if it did not)
 */
export async function evaluateStrudel(code) {
  const { core, transpiler } = await loadStrudel();
  let error;
  // The REPL logs evaluation to the console. Here a failure is thrown instead.
  const { pattern, cps } = await quietly(['log', 'error'], async () => {
    const repl = core.repl({ defaultOutput: () => {}, getTime: () => 0, transpiler, onEvalError: (e) => (error = e) });
    const evaluated = await repl.evaluate(code, false);
    error ??= repl.state?.evalError;
    return { pattern: evaluated, cps: repl.scheduler.cps };
  });
  if (error) throw error;
  if (!pattern || typeof pattern.queryArc !== 'function') throw new Error('the code left no pattern to play');
  return { pattern, cps };
}

/**
 * Queries a pattern and reads each onset as PAM events, with times in beats.
 *
 * @param {object} pattern a Strudel pattern
 * @param {object} options
 * @param {number} options.cycles how many cycles to take
 * @param {number} [options.begin] first cycle (default 0)
 * @param {number} [options.beatsPerCycle] default 4: one cycle is one 4/4 bar
 * @param {import('../pam/midimap.mjs').PamSetup} [options.setup]
 * @param {boolean} [options.all] also read haps that were not sent to `.pam()` (default: only those)
 * @returns {{ timeline: import('../pam/freeze.mjs').TimelineEntry[], problems: string[], haps: number }}
 */
export function collect(pattern, { cycles, begin = 0, beatsPerCycle = 4, setup = createSetup(), all = false } = {}) {
  if (!(cycles > 0)) throw new Error('collect needs the number of cycles');
  const timeline = [];
  const problems = new Set();
  let haps = 0;
  for (const hap of pattern.queryArc(begin, begin + cycles)) {
    if (!hap.hasOnset()) continue;
    if (!all && hap.context?.pam === undefined) continue;
    const compiled = compileValue(hap.value, setup);
    compiled.problems.forEach((p) => problems.add(p));
    // A MIDI clock is for a PAM that is listening: offline there is nothing for it to keep time with.
    const events = compiled.events.filter((event) => event.type !== 'transport');
    if (compiled.events.length && !events.length) continue;
    haps++;
    if (!events.length) continue;
    timeline.push({
      beat: (Number(hap.whole.begin) - begin) * beatsPerCycle,
      beats: Number(hap.duration) * beatsPerCycle,
      events,
    });
  }
  timeline.sort((a, b) => a.beat - b.beat);
  return { timeline, problems: [...problems], haps };
}
