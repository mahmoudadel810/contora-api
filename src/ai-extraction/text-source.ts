import { Injectable } from '@nestjs/common';
import type { FileKind, TextSource } from './extraction.types.js';
import { completeUtf8Prefix } from './file-sniff.js';
import { cleanText, hasVisibleText } from './text-clean.js';

export type TextExtraction =
  | { ok: true; text: string; truncated: boolean; source: TextSource }
  | { ok: false; reason: 'busy' | 'timeout' | 'no_text' | 'unsupported' };

export interface StagedFileInfo {
  kind: FileKind;
  mimeType: string;
  size: number;
}

export abstract class ExtractionTextSource {
  abstract supports(kind: FileKind): boolean;
  abstract maxBytes(kind: FileKind): number;
  abstract extract(
    bytes: Buffer,
    file: StagedFileInfo,
    signal: AbortSignal,
  ): Promise<TextExtraction>;
}

export const PLAIN_TEXT_READ_BYTES = 1024 * 1024;

@Injectable()
export class PlainTextSource extends ExtractionTextSource {
  supports(kind: FileKind): boolean {
    return kind === 'text';
  }

  maxBytes(kind: FileKind): number {
    return kind === 'text' ? PLAIN_TEXT_READ_BYTES : 0;
  }

  extract(bytes: Buffer, file: StagedFileInfo, signal: AbortSignal): Promise<TextExtraction> {
    if (signal.aborted) return Promise.resolve({ ok: false, reason: 'timeout' });
    if (file.kind !== 'text') return Promise.resolve({ ok: false, reason: 'unsupported' });
    const truncated = file.size > bytes.length;
    const usable = truncated ? completeUtf8Prefix(bytes) : bytes;
    if (usable.includes(0)) return Promise.resolve({ ok: false, reason: 'unsupported' });
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(usable);
    } catch {
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }
    const text = cleanText(decoded);
    if (!hasVisibleText(text)) return Promise.resolve({ ok: false, reason: 'no_text' });
    return Promise.resolve({ ok: true, text, truncated, source: 'plain' });
  }
}
