export const UA_FAMILIES = ['chrome', 'firefox', 'safari', 'edge', 'other'] as const;
export type UaFamily = (typeof UA_FAMILIES)[number];

export function uaFamilyOf(raw: unknown): UaFamily {
  const value = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (typeof value !== 'string') return 'other';
  if (/\bEdg(e|A|iOS)?\//.test(value)) return 'edge';
  if (/\b(OPR|OPiOS|Opera)\b/.test(value)) return 'other';
  if (/\b(Firefox|FxiOS)\//.test(value)) return 'firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(value)) return 'chrome';
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(value)) return 'safari';
  return 'other';
}
