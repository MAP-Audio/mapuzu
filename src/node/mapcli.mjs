/*
mapcli.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Runs mapcli, MAP Audio's command-line tool, which holds PAM's engine. mapuzu never links PAM:
// everything that needs the engine (saving a preset, rendering) is a mapcli call.

import { spawn } from 'node:child_process';

/** The mapcli to run: an explicit path, else `$MAPCLI`, else `mapcli` on the PATH. */
export const mapcliPath = (explicit) => explicit || process.env.MAPCLI || 'mapcli';

export class MapcliError extends Error {
  constructor(message, { code, exitCode, result, args }) {
    super(message);
    this.name = 'MapcliError';
    this.code = code;
    this.exitCode = exitCode;
    this.result = result;
    this.args = args;
  }
}

/**
 * Runs one mapcli command with `--json` and returns its result object.
 *
 * @param {string[]} args the command and its options, without `--json`
 * @param {object} [options]
 * @param {string} [options.mapcli] path to the binary
 * @param {string} [options.cwd]
 * @param {(fraction: number) => void} [options.onProgress] mapcli's render progress, 0..1
 * @param {typeof spawn} [options.spawn] test seam
 * @returns {Promise<object>}
 */
export function mapcli(args, { mapcli: bin, cwd, onProgress, spawn: spawnFn = spawn } = {}) {
  const command = mapcliPath(bin);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, [...args, '--json'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!onProgress) return;
      for (const line of String(d).split('\n')) {
        const m = /"progress":\s*([\d.]+)/.exec(line);
        if (m) onProgress(Number(m[1]));
      }
    });
    child.on('error', (err) => {
      const hint = err.code === 'ENOENT' ? `: "${command}" was not found. Pass --mapcli, or set MAPCLI` : '';
      reject(new MapcliError(`mapcli could not start${hint}`, { code: err.code, args }));
    });
    child.on('close', (exitCode) => {
      let result;
      try {
        result = JSON.parse(stdout.trim().split('\n').at(-1));
      } catch {
        result = undefined;
      }
      if (exitCode === 0 && result?.ok !== false) return resolve(result ?? {});
      const why = result?.error ?? (stderr.trim().split('\n').filter((l) => !l.includes('"progress"')).at(-1) || `exit ${exitCode}`);
      const licence = exitCode === 3 ? ' (this command needs a PAM licence or trial on this machine)' : '';
      reject(new MapcliError(`mapcli ${args.slice(0, 2).join(' ')} failed: ${why}${licence}`, { code: result?.code, exitCode, result, args }));
    });
  });
}
