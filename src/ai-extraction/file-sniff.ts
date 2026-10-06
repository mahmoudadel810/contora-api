import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileKind } from './extraction.types.js';

export const SNIFF_BYTES = 8 * 1024;

const TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/csv', 'text/markdown']);

const startsWith = (head: Buffer, signature: readonly number[]): boolean =>
  head.length >= signature.length && signature.every((byte, index) => head[index] === byte);

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function isImage(head: Buffer): boolean {
  const webp =
    head.length >= 12 &&
    head.toString('latin1', 0, 4) === 'RIFF' &&
    head.toString('latin1', 8, 12) === 'WEBP';
  return startsWith(head, PNG) || startsWith(head, JPEG) || webp;
}

export function baseMimeType(declared: string): string {
  return (declared.split(';')[0] ?? '').trim().toLowerCase();
}

export function completeUtf8Prefix(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

export function isUtf8Text(bytes: Buffer, complete: boolean): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(complete ? bytes : completeUtf8Prefix(bytes));
    return true;
  } catch {
    return false;
  }
}

export function sniffKind(
  head: Buffer,
  declaredMimeType: string,
  complete: boolean,
): FileKind | null {
  if (startsWith(head, PDF)) return 'pdf';
  if (startsWith(head, ZIP)) return 'zip';
  if (isImage(head)) return null;
  if (!TEXT_TYPES.has(baseMimeType(declaredMimeType))) return null;
  return isUtf8Text(head, complete) ? 'text' : null;
}

export async function readHead(path: string, length: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
