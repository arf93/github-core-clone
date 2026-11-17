// git-objects.ts — byte git murni: pkt-line, packfile, sideband, zlib.
//
// Tidak tahu HTTP. Hanya mengimpor store.ts (sha-1 git + type) dan node:*.
// TypeScript erasable saja; tanpa Date.now()/Math.random()/UUID.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { gitObjectSha } from './store.ts';
import type { GitObject, GitObjectType } from './store.ts';

// ---------------------------------------------------------------------------
// Pkt-line (git.md §5.1)
// ---------------------------------------------------------------------------

/** Panjang total maksimum satu pkt-line, termasuk 4 byte header. */
export const PKT_LINE_MAX = 65520;

/** Satu paket pkt-line yang sudah di-decode. */
export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Encode satu pkt-line data. Panjang = payload + 4, header hex lowercase. */
export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  if (total > PKT_LINE_MAX) throw new Error(`pkt-line too long: ${total}`);
  const header = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Encode satu baris teks (string) sebagai pkt-line. */
export function pktLineString(text: string): Buffer {
  return encodePktLine(Buffer.from(text, 'utf8'));
}

/** Paket flush `0000`. */
export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** Paket delim `0001`. */
export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Paket response-end `0002`. */
export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/**
 * Decode semua pkt-line dari awal buffer.
 * Berhenti (bukan throw) begitu menemui 4 byte yang bukan header hex
 * (mis. awal packfile mentah `PACK`) atau sisa < 4 byte: sisanya
 * dikembalikan sebagai `trailing`. Panjang tidak valid / paket terpotong
 * di tengah -> throw (pemanggil menjawab 400, server tetap hidup).
 */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; trailing: Buffer } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 4) return { packets, trailing: Buffer.from(buf.subarray(off)) };
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      return { packets, trailing: Buffer.from(buf.subarray(off)) };
    }
    const len = Number.parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return { packets, trailing: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// zlib
// ---------------------------------------------------------------------------

/** Inflate satu stream zlib (format zlib, bukan raw). */
export function inflateBuffer(data: Buffer): Buffer {
  return inflateSync(data);
}

/** Deflate ke format zlib. */
export function deflateBuffer(data: Buffer): Buffer {
  return deflateSync(data);
}

// ---------------------------------------------------------------------------
// Sideband (git.md §5.2)
// ---------------------------------------------------------------------------

/**
 * Bungkus `data` menjadi paket-paket sideband band `band` (1 = data,
 * 2 = progress, 3 = error). Tiap paket pkt-line total <= 65520 byte,
 * jadi tiap chunk data <= 65515 byte (1 byte nomor band + data).
 */
export function wrapSideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX - 4 - 1;
  if (data.length === 0) {
    chunks.push(encodePktLine(Buffer.from([band])));
    return Buffer.concat(chunks);
  }
  for (let off = 0; off < data.length; off += maxChunk) {
    const piece = data.subarray(off, Math.min(off + maxChunk, data.length));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

function readDeltaVarint(delta: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = pos;
  while (i < delta.length) {
    const byte = delta[i];
    i += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/**
 * Terapkan satu delta git ke `base`. Verifikasi: ukuran sumber harus sama
 * dengan panjang basis, hasil harus tepat sepanjang ukuran target.
 * Throw bila opcode 0, copy keluar batas, atau ukuran tidak cocok.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const tgt = readDeltaVarint(delta, src.next);
  const chunks: Buffer[] = [];
  let total = 0;
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (i >= delta.length) throw new Error('delta copy truncated');
          offset += delta[i] * 2 ** (8 * bit);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (i >= delta.length) throw new Error('delta copy truncated');
          size += delta[i] * 2 ** (8 * bit);
          i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of bounds');
      const piece = base.subarray(offset, offset + size);
      chunks.push(Buffer.from(piece));
      total += piece.length;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta insert truncated');
      const piece = delta.subarray(i, i + op);
      chunks.push(Buffer.from(piece));
      total += piece.length;
      i += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (total !== tgt.value) throw new Error('delta target size mismatch');
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Packfile
// ---------------------------------------------------------------------------

const TYPE_CODE_TO_NAME: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const TYPE_NAME_TO_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** Urutan deterministik entri pack: commit, tag, tree, blob, lalu oid naik. */
const TYPE_RANK: Record<GitObjectType, number> = {
  commit: 0,
  tag: 1,
  tree: 2,
  blob: 3,
};

export interface PackObject {
  oid: string;
  type: GitObjectType;
  data: Buffer;
  delta: boolean;
}

export interface ParsedPack {
  version: number;
  declaredCount: number;
  objects: Map<string, PackObject>;
  deltas: number;
}

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  let sizeLeft = size;
  let byte = (typeCode << 4) | (sizeLeft & 0x0f);
  sizeLeft = Math.floor(sizeLeft / 16);
  while (sizeLeft > 0) {
    byte |= 0x80;
    out.push(byte);
    byte = sizeLeft & 0x7f;
    sizeLeft = Math.floor(sizeLeft / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

/**
 * Bangun packfile v2 berisi objek PENUH tanpa delta (0 delta), urutan
 * deterministik, trailer = SHA-1 atas semua byte sebelumnya.
 */
export function buildPack(objects: Iterable<GitObject> | Map<string, GitObject>): Buffer {
  const list: GitObject[] = [...objects];
  list.sort((a, b) => {
    const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (rank !== 0) return rank;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  chunks.push(header);
  for (const obj of list) {
    chunks.push(encodePackEntryHeader(TYPE_NAME_TO_CODE[obj.type], obj.data.length));
    chunks.push(deflateBuffer(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Cari panjang stream zlib yang dimulai di `start` (di dalam `buf`, batas
 * atas `limit`) dengan binary search: inflateSync melempar bila stream
 * terpotong dan mengabaikan trailing byte bila stream sudah lengkap, jadi
 * predikat "inflate berhasil dengan panjang hasil == expectedSize" monoton.
 */
function findInflateLength(buf: Buffer, start: number, limit: number, expectedSize: number): { data: Buffer; end: number } {
  const full = (() => {
    try {
      return inflateSync(buf.subarray(start, limit));
    } catch {
      return null;
    }
  })();
  if (full === null || full.length !== expectedSize) {
    throw new Error('pack zlib inflate failed or size mismatch');
  }
  let lo = start;
  let hi = limit;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(start, mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(buf.subarray(start, lo)), end: lo };
}

/**
 * Parse packfile v2/v3: objek penuh + OFS_DELTA + REF_DELTA (termasuk thin
 * pack: basis REF_DELTA boleh dipasok lewat `baseObjects`). Setiap objek
 * hasil (termasuk hasil delta) diverifikasi SHA-1-nya. Trailer checksum
 * diverifikasi dulu. Throw bila struktur rusak.
 */
export function parsePack(buf: Buffer, baseObjects?: Map<string, GitObject>): ParsedPack {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header missing PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailerHex = buf.subarray(trailerStart).toString('hex');
  const actualHex = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (actualHex !== trailerHex) throw new Error('pack checksum mismatch');

  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  let deltas = 0;
  let off = 12;
  for (let n = 0; n < declaredCount; n += 1) {
    const entryStart = off;
    if (off >= trailerStart) throw new Error('pack truncated');
    let byte = buf[off];
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (off >= trailerStart) throw new Error('pack truncated');
      byte = buf[off];
      off += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      if (off >= trailerStart) throw new Error('pack truncated');
      byte = buf[off];
      off += 1;
      let ofs = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (off >= trailerStart) throw new Error('pack truncated');
        byte = buf[off];
        off += 1;
        ofs = (ofs + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = entryStart - ofs;
      if (baseOffset < 0) throw new Error('delta base offset out of range');
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('pack truncated');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (TYPE_CODE_TO_NAME[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = findInflateLength(buf, off, trailerStart, size);
    off = inflated.end;
    const raw = inflated.data;
    if (typeCode === 6 || typeCode === 7) {
      let base: PackObject | GitObject | undefined;
      if (baseOffset !== null) base = byOffset.get(baseOffset);
      else if (baseOid !== null) base = objects.get(baseOid) ?? baseObjects?.get(baseOid);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, raw);
      const type = base.type;
      const oid = gitObjectSha(type, data);
      const resolved: PackObject = { oid, type, data, delta: true };
      deltas += 1;
      objects.set(oid, resolved);
      byOffset.set(entryStart, resolved);
    } else {
      const type = TYPE_CODE_TO_NAME[typeCode] as GitObjectType;
      const oid = gitObjectSha(type, raw);
      const resolved: PackObject = { oid, type, data: raw, delta: false };
      objects.set(oid, resolved);
      byOffset.set(entryStart, resolved);
    }
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  return { version, declaredCount, objects, deltas };
}

/** Oid target baris pertama objek tag (`object <oid>`), atau null. */
export function tagTargetOid(tagData: Buffer): string | null {
  const firstLine = tagData.toString('utf8').split('\n')[0] ?? '';
  if (!firstLine.startsWith('object ')) return null;
  const oid = firstLine.slice(7).trim();
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}
