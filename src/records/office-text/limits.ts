import type { OfficeLimits } from './types.js';

const KIB = 1024;
const MIB = 1024 * KIB;

export const CONTENT_TEXT_MAX_CHARS_DEFAULT = 100_000;

export const MAX_SKIP_DEPTH = 10_000;

export const MAX_HEADER_FOOTER_PARTS = 30;

export const ENTITY_LOOKAHEAD = 10;

export const MAX_NAME_BYTES = 1024;

export const RESOLVE_BUDGET_FACTOR = 4;

const KEYS: readonly (keyof OfficeLimits)[] = [
  'maxEntries',
  'maxCentralDirBytes',
  'maxPartBytes',
  'maxTotalBytes',
  'maxParts',
  'maxTagChars',
  'maxSharedStrings',
  'maxRawChars',
];

export function officeLimits(overrides: Partial<OfficeLimits> = {}): OfficeLimits {
  const limits: OfficeLimits = {
    maxEntries: 10_000,
    maxCentralDirBytes: 4 * MIB,
    maxPartBytes: 32 * MIB,
    maxTotalBytes: 64 * MIB,
    maxParts: 1_000,
    maxTagChars: 64 * KIB,
    maxSharedStrings: 1_000_000,
    maxRawChars: 2 * CONTENT_TEXT_MAX_CHARS_DEFAULT,
  };
  for (const key of KEYS) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      limits[key] = value;
    }
  }
  return limits;
}
