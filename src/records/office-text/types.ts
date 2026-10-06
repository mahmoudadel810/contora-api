export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export type OfficeNoText =
  'not-zip' | 'ole-container' | 'not-ooxml' | 'unsupported-zip' | 'corrupt' | 'limit' | 'empty';

export type OfficeTextResult =
  | { ok: true; format: OfficeFormat; text: string; truncated: boolean }
  | { ok: false; reason: OfficeNoText };

export interface OfficeLimits {
  maxEntries: number;
  maxCentralDirBytes: number;
  maxPartBytes: number;
  maxTotalBytes: number;
  maxParts: number;
  maxTagChars: number;
  maxSharedStrings: number;
  maxRawChars: number;
}
