/*
serve.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// `mapuzu serve`: this package's browser modules over HTTP on this machine, so a page that already
// runs Strudel (strudel.cc) can `await import('http://localhost:4747/mapuzu.mjs')`. It serves what
// that import needs and the songs, to this machine only, and nothing else.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, sep } from 'node:path';

export const SERVE_PORT = 4747;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// The page entry, the modules it imports, and the song files. Not the Node side or the tests.
const SERVED = [/^mapuzu\.mjs$/, /^src\/(pam|strudel)\/[\w.-]+\.mjs$/, /^songs\/[\w-]+\/[\w.-]+\.strudel\.js$/];

// A page on another origin reads these, and a public page reaching this machine asks first.
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' };

/**
 * Listens on this machine only.
 * @param {import('node:http').Server} server
 * @param {number} port 0 picks a free one
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function listenLocal(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => {
          server.closeAllConnections();
          return new Promise((done) => server.close(() => done()));
        },
      }),
    );
  });
}

/**
 * Starts the server.
 * @param {object} [options]
 * @param {number} [options.port] default 4747. 0 picks a free one
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function serve({ port = SERVE_PORT } = {}) {
  const server = createServer(async (request, response) => {
    const send = (status, body = '', headers = {}) => {
      response.writeHead(status, { ...CORS, 'Cache-Control': 'no-store', ...headers });
      response.end(body);
    };
    if (request.method === 'OPTIONS') return send(204, '', { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' });
    if (request.method !== 'GET') return send(405);
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)).split(sep).filter(Boolean).join('/');
    } catch {
      return send(400);
    }
    if (!SERVED.some((allowed) => allowed.test(path))) return send(404, `mapuzu serve has no ${path}\n`);
    try {
      send(200, await readFile(join(ROOT, path)), { 'Content-Type': 'text/javascript; charset=utf-8' });
    } catch {
      send(404, `mapuzu serve has no ${path}\n`);
    }
  });
  const { port: bound, close } = await listenLocal(server, port);
  return { url: `http://localhost:${bound}/mapuzu.mjs`, port: bound, close };
}
