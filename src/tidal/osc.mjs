/*
osc.mjs - part of @mapaudio/mapuzu
This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details. You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// Open Sound Control 1.0, as much of it as TidalCycles sends: messages and bundles in, with each
// message's time; and messages and bundles out, for the tests and for anything that stands
// in for Tidal. No dependency, and nothing here knows about PAM.

// NTP counts seconds from 1900, Unix from 1970.
const NTP_UNIX_SECONDS = 2208988800;

const pad4 = (n) => (n + 3) & ~3;

/** An OSC time tag (seconds and 2^-32 fractions since 1900) as Unix milliseconds, or `undefined` for "immediately". */
export function timetagToMs(seconds, fraction) {
  if (seconds === 0 && fraction <= 1) return undefined;
  return (seconds - NTP_UNIX_SECONDS) * 1000 + (fraction / 0x100000000) * 1000;
}

function readString(view, bytes, at) {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  if (end >= bytes.length) throw new Error('OSC: a string runs off the end of the packet');
  return { value: new TextDecoder().decode(bytes.subarray(at, end)), next: pad4(end + 1) };
}

function readMessage(view, bytes, at, end, time, out) {
  const address = readString(view, bytes, at);
  if (address.next >= end) {
    out.push({ address: address.value, args: [], time });
    return;
  }
  const tags = readString(view, bytes, address.next);
  if (tags.value[0] !== ',') throw new Error(`OSC: ${address.value} has no type tags`);
  let p = tags.next;
  const args = [];
  const need = (n) => {
    if (p + n > end) throw new Error(`OSC: ${address.value} is shorter than its type tags say`);
  };
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i':
        need(4);
        args.push(view.getInt32(p));
        p += 4;
        break;
      case 'f':
        need(4);
        args.push(view.getFloat32(p));
        p += 4;
        break;
      case 'd':
        need(8);
        args.push(view.getFloat64(p));
        p += 8;
        break;
      case 'h':
        need(8);
        args.push(Number(view.getBigInt64(p)));
        p += 8;
        break;
      case 't':
        need(8);
        args.push(timetagToMs(view.getUint32(p), view.getUint32(p + 4)));
        p += 8;
        break;
      case 's':
      case 'S': {
        const s = readString(view, bytes, p);
        args.push(s.value);
        p = s.next;
        break;
      }
      case 'b': {
        need(4);
        const size = view.getInt32(p);
        need(4 + size);
        args.push(bytes.slice(p + 4, p + 4 + size));
        p = pad4(p + 4 + size);
        break;
      }
      case 'c':
      case 'r':
      case 'm':
        need(4);
        args.push(view.getUint32(p));
        p += 4;
        break;
      case 'T':
        args.push(true);
        break;
      case 'F':
        args.push(false);
        break;
      case 'N':
      case 'I':
        args.push(null);
        break;
      default:
        throw new Error(`OSC: ${address.value} has an argument of type "${tag}"`);
    }
  }
  out.push({ address: address.value, args, time });
}

function readPacket(view, bytes, at, end, time, out) {
  if (end - at >= 16 && bytes[at] === 0x23 && new TextDecoder().decode(bytes.subarray(at, at + 7)) === '#bundle') {
    const stamp = timetagToMs(view.getUint32(at + 8), view.getUint32(at + 12));
    let p = at + 16;
    while (p + 4 <= end) {
      const size = view.getInt32(p);
      if (size < 0 || p + 4 + size > end) throw new Error('OSC: a bundle element runs off the end of the packet');
      // A bundle inside a bundle keeps its own time, and one with none takes the outer one's.
      readPacket(view, bytes, p + 4, p + 4 + size, stamp ?? time, out);
      p += 4 + size;
    }
    return;
  }
  readMessage(view, bytes, at, end, time, out);
}

/**
 * Reads one UDP packet: a message, or a bundle of them.
 *
 * @param {Uint8Array} packet
 * @returns {{ address: string, args: unknown[], time?: number }[]} every message in it, in order.
 *   `time` is its bundle's time tag in Unix milliseconds, absent for a bare message or "immediately"
 */
export function decodePacket(packet) {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  readPacket(view, bytes, 0, bytes.length, undefined, out);
  return out;
}

function stringBytes(text) {
  const raw = new TextEncoder().encode(text);
  const out = new Uint8Array(pad4(raw.length + 1));
  out.set(raw);
  return out;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Writes one message. A string is `s`, and a number is `f`, or `i` when given as `{ int: n }`, which is
 * how Tidal's integer parameters arrive.
 *
 * @param {string} address
 * @param {(string | number | { int: number })[]} args
 * @returns {Uint8Array}
 */
export function encodeMessage(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const arg of args) {
    const four = new Uint8Array(4);
    if (typeof arg === 'string') {
      tags += 's';
      parts.push(stringBytes(arg));
    } else if (typeof arg === 'number') {
      tags += 'f';
      new DataView(four.buffer).setFloat32(0, arg);
      parts.push(four);
    } else if (arg && typeof arg.int === 'number') {
      tags += 'i';
      new DataView(four.buffer).setInt32(0, arg.int);
      parts.push(four);
    } else throw new Error(`OSC: cannot write ${JSON.stringify(arg)}`);
  }
  return concat([stringBytes(address), stringBytes(tags), ...parts]);
}

/**
 * Writes a bundle stamped for `timeMs` (Unix milliseconds), as Tidal's `Pre BundleStamp` does.
 * @param {number} timeMs
 * @param {Uint8Array[]} messages encoded messages (or bundles)
 * @returns {Uint8Array}
 */
export function encodeBundle(timeMs, messages) {
  const head = new Uint8Array(16);
  head.set(stringBytes('#bundle'));
  const seconds = Math.floor(timeMs / 1000);
  const view = new DataView(head.buffer);
  view.setUint32(8, seconds + NTP_UNIX_SECONDS);
  view.setUint32(12, Math.round(((timeMs - seconds * 1000) / 1000) * 0x100000000) >>> 0);
  const parts = [head];
  for (const message of messages) {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setInt32(0, message.length);
    parts.push(size, message);
  }
  return concat(parts);
}
