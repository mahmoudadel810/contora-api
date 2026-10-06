import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { MAX_NAME_BYTES } from './limits.js';
import type { OfficeLimits, OfficeNoText } from './types.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export type ReadFailure = 'missing' | 'corrupt' | 'limit' | 'released';

export interface ZipArchive {
  has(name: string): boolean;
  read(name: string): Uint8Array | null;
  release(name: string): void;
  failure(name: string): ReadFailure | undefined;
  names(): string[];
  readonly exhausted: boolean;
  readonly readLog: readonly string[];
}

interface Entry {
  key: string;
  method: number;
  localStart: number;
  dataStart: number;
  dataEnd: number;
}

function u16(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8)) >>> 0;
}

function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

function inRange(start: number, len: number, limit: number): boolean {
  return start >= 0 && len >= 0 && start + len <= limit;
}

export function lookupKey(name: string): string {
  let i = 0;
  while (i < name.length && name.charCodeAt(i) === 47) i++;
  return name.slice(i).toLowerCase();
}

function entryKey(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  return lookupKey(decoded);
}

function findEocd(bytes: Uint8Array): number {
  const length = bytes.length;
  if (length < EOCD_SIZE) return -1;
  const lowest = Math.max(0, length - EOCD_SIZE - MAX_COMMENT);
  for (let pos = length - EOCD_SIZE; pos >= lowest; pos--) {
    if (u32(bytes, pos) !== SIG_EOCD) continue;
    if (pos + EOCD_SIZE + u16(bytes, pos + 20) === length) return pos;
  }
  return -1;
}

function isTooLarge(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_BUFFER_TOO_LARGE'
  );
}

export function readZip(bytes: Uint8Array, limits: OfficeLimits): ZipArchive | OfficeNoText {
  const eocd = findEocd(bytes);
  if (eocd < 0) return 'corrupt';
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_EOCD64_LOCATOR) return 'unsupported-zip';
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (
    disk === U16_MAX ||
    cdDisk === U16_MAX ||
    onDisk === U16_MAX ||
    total === U16_MAX ||
    cdSize === U32_MAX ||
    cdOffset === U32_MAX
  ) {
    return 'unsupported-zip';
  }
  if (disk !== 0 || cdDisk !== 0) return 'unsupported-zip';
  if (onDisk !== total) return 'corrupt';
  if (!inRange(cdOffset, cdSize, eocd)) return 'corrupt';
  if (cdSize > limits.maxCentralDirBytes || total > limits.maxEntries) return 'limit';

  const names = new TextDecoder('utf-8');
  const cdEnd = cdOffset + cdSize;
  const entries = new Map<string, Entry>();
  const ranges: Entry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (!inRange(p, CENTRAL_SIZE, cdEnd) || u32(bytes, p) !== SIG_CENTRAL) return 'corrupt';
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressed = u32(bytes, p + 20);
    const uncompressed = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const recordLen = CENTRAL_SIZE + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    const diskStart = u16(bytes, p + 34);
    const localOffset = u32(bytes, p + 42);
    if (!inRange(p, recordLen, cdEnd)) return 'corrupt';
    if ((flags & 1) !== 0) return 'unsupported-zip';
    if (
      compressed === U32_MAX ||
      uncompressed === U32_MAX ||
      localOffset === U32_MAX ||
      diskStart === U16_MAX
    ) {
      return 'unsupported-zip';
    }
    if (diskStart !== 0) return 'unsupported-zip';

    if (nameLen > MAX_NAME_BYTES) return 'corrupt';
    const nameStart = p + CENTRAL_SIZE;
    for (let i = nameStart; i < nameStart + nameLen; i++) if (bytes[i] === 0) return 'corrupt';
    const key = entryKey(names.decode(bytes.subarray(nameStart, nameStart + nameLen)));
    if (entries.has(key)) return 'corrupt';

    if (!inRange(localOffset, LOCAL_SIZE, cdOffset) || u32(bytes, localOffset) !== SIG_LOCAL) {
      return 'corrupt';
    }
    const dataStart =
      localOffset + LOCAL_SIZE + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (!inRange(dataStart, compressed, cdOffset)) return 'corrupt';
    const entry: Entry = {
      key,
      method,
      localStart: localOffset,
      dataStart,
      dataEnd: dataStart + compressed,
    };
    entries.set(key, entry);
    ranges.push(entry);
    p += recordLen;
  }
  if (p !== cdEnd) return 'corrupt';

  ranges.sort((a, b) => a.localStart - b.localStart);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].localStart < ranges[i - 1].dataEnd) return 'corrupt';
  }

  let remaining = limits.maxTotalBytes;
  let partsRead = 0;
  const memo = new Map<string, Uint8Array | null>();
  const failures = new Map<string, ReadFailure>();
  const readLog: string[] = [];

  const charge = (n: number): void => {
    remaining = Math.max(0, remaining - n);
  };
  const fail = (key: string, why: ReadFailure): null => {
    failures.set(key, why);
    memo.set(key, null);
    return null;
  };

  const read = (name: string): Uint8Array | null => {
    const key = lookupKey(name);
    if (memo.has(key)) return memo.get(key) ?? null;
    const entry = entries.get(key);
    if (entry === undefined) {
      failures.set(key, 'missing');
      return null;
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      return fail(key, 'corrupt');
    }
    if (remaining === 0 || partsRead >= limits.maxParts) return fail(key, 'limit');
    partsRead++;
    readLog.push(key);
    const size = entry.dataEnd - entry.dataStart;
    if (size === 0) {
      const empty = new Uint8Array(0);
      memo.set(key, empty);
      return empty;
    }
    const cap = Math.min(limits.maxPartBytes, remaining);
    if (cap < 1) return fail(key, 'limit');
    if (!inRange(entry.dataStart, size, bytes.length)) return fail(key, 'corrupt');
    const data = bytes.subarray(entry.dataStart, entry.dataEnd);
    if (entry.method === METHOD_STORED) {
      if (size > cap) {
        charge(cap);
        return fail(key, 'limit');
      }
      charge(size);
      memo.set(key, data);
      return data;
    }
    try {
      const out = inflateRawSync(data, { maxOutputLength: cap });
      charge(out.length);
      memo.set(key, out);
      return out;
    } catch (error: unknown) {
      charge(cap);
      return fail(key, isTooLarge(error) ? 'limit' : 'corrupt');
    }
  };

  const release = (name: string): void => {
    const key = lookupKey(name);
    if (!(memo.get(key) instanceof Uint8Array)) return;
    fail(key, 'released');
  };

  return {
    has: (name) => entries.has(lookupKey(name)),
    read,
    release,
    failure: (name) => failures.get(lookupKey(name)),
    names: () => [...entries.keys()],
    get exhausted() {
      return remaining === 0;
    },
    readLog,
  };
}
