import { officeLimits } from './limits.js';
import { extractFromArchive } from './ooxml.js';
import type { OfficeLimits, OfficeTextResult } from './types.js';
import { readZip } from './zip-reader.js';

export type { OfficeFormat, OfficeLimits, OfficeNoText, OfficeTextResult } from './types.js';

export function sniffContainer(head: Uint8Array): 'zip' | 'ole' | null {
  if (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  ) {
    return 'ole';
  }
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))
  ) {
    return 'zip';
  }
  return null;
}

export function extractOfficeText(
  bytes: Uint8Array,
  limits?: Partial<OfficeLimits>,
): OfficeTextResult {
  try {
    const kind = sniffContainer(bytes);
    if (kind === 'ole') return { ok: false, reason: 'ole-container' };
    if (kind === null) return { ok: false, reason: 'not-zip' };
    const resolved = officeLimits(limits);
    const zip = readZip(bytes, resolved);
    if (typeof zip === 'string') return { ok: false, reason: zip };
    return extractFromArchive(zip, resolved);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}
