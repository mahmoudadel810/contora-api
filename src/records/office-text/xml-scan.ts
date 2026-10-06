import { TextDecoder } from 'node:util';
import { ENTITY_LOOKAHEAD } from './limits.js';

export type ScanStatus = 'ok' | 'stopped' | 'corrupt';
export type HaltSignal = 'stop' | 'corrupt' | null;

export interface XmlHandler {
  open(local: string, attrs: ReadonlyMap<string, string>): void;
  close(local: string): void;
  text(value: string): void;
  textRoom?(): number;
  halt?(): HaltSignal;
}

const SEMI = 59;
const HASH = 35;
const LOWER_X = 120;
const GT = 62;
const QUOT = 34;
const APOS = 39;
const SLASH = 47;
const BANG = 33;
const QUESTION = 63;
const EQ = 61;

export function decodeXml(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function digitValue(c: number, hex: boolean): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (hex && c >= 97 && c <= 102) return c - 87;
  if (hex && c >= 65 && c <= 70) return c - 55;
  return -1;
}

function numericEntity(s: string, start: number, end: number): string | null {
  let i = start;
  const hex = i < end && s.charCodeAt(i) === LOWER_X;
  if (hex) i++;
  const digits = end - i;
  if (digits < 1 || digits > (hex ? 6 : 7)) return null;
  let cp = 0;
  for (; i < end; i++) {
    const d = digitValue(s.charCodeAt(i), hex);
    if (d < 0) return null;
    cp = cp * (hex ? 16 : 10) + d;
  }
  if (cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

function entityValue(s: string, start: number, end: number): string | null {
  if (end <= start) return null;
  if (s.charCodeAt(start) === HASH) return numericEntity(s, start + 1, end);
  switch (s.slice(start, end)) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      return null;
  }
}

const JOIN_CHUNK = 1024;

export function decodeEntities(s: string, max: number = Number.POSITIVE_INFINITY): string {
  let amp = s.indexOf('&');
  if (amp === -1) return s;
  const done: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  const add = (piece: string): void => {
    chunk.push(piece);
    size += piece.length;
    if (chunk.length >= JOIN_CHUNK) {
      done.push(chunk.join(''));
      chunk = [];
    }
  };
  const result = (): string => {
    done.push(chunk.join(''));
    return done.join('');
  };
  const literal = (from: number, to: number): boolean => {
    if (to <= from) return false;
    const room = Math.max(0, max - size);
    if (to - from <= room) {
      add(s.slice(from, to));
      return false;
    }
    add(s.slice(from, from + room + 1));
    return true;
  };
  let from = 0;
  while (amp !== -1) {
    const windowEnd = Math.min(s.length, amp + 1 + ENTITY_LOOKAHEAD);
    let semi = -1;
    for (let j = amp + 1; j < windowEnd; j++) {
      if (s.charCodeAt(j) === SEMI) {
        semi = j;
        break;
      }
    }
    const value = semi === -1 ? null : entityValue(s, amp + 1, semi);
    if (value === null) {
      amp = s.indexOf('&', amp + 1);
      continue;
    }
    if (literal(from, amp)) return result();
    if (value.length > 0) add(value);
    if (size > max) return result();
    from = semi + 1;
    amp = s.indexOf('&', from);
  }
  literal(from, s.length);
  return result();
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

function localName(qualified: string): string {
  const colon = qualified.lastIndexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function nameEnd(xml: string, from: number, to: number): number {
  let i = from;
  while (i < to) {
    const c = xml.charCodeAt(i);
    if (isSpace(c) || c === SLASH) break;
    i++;
  }
  return i;
}

function parseAttributes(xml: string, from: number, to: number): Map<string, string> {
  const attrs = new Map<string, string>();
  let i = from;
  while (i < to) {
    while (i < to && isSpace(xml.charCodeAt(i))) i++;
    if (i >= to) break;
    const start = i;
    while (i < to) {
      const c = xml.charCodeAt(i);
      if (c === EQ || isSpace(c)) break;
      i++;
    }
    const name = xml.slice(start, i);
    while (i < to && isSpace(xml.charCodeAt(i))) i++;
    if (i >= to || xml.charCodeAt(i) !== EQ) break;
    i++;
    while (i < to && isSpace(xml.charCodeAt(i))) i++;
    if (i >= to) break;
    const quote = xml.charCodeAt(i);
    if (quote !== QUOT && quote !== APOS) break;
    let end = i + 1;
    while (end < to && xml.charCodeAt(end) !== quote) end++;
    if (end >= to) break;
    if (name.length > 0 && !attrs.has(name)) {
      attrs.set(name, decodeEntities(xml.slice(i + 1, end)));
    }
    i = end + 1;
  }
  return attrs;
}

function poll(handler: XmlHandler): ScanStatus | null {
  const signal = handler.halt?.() ?? null;
  if (signal === 'stop') return 'stopped';
  if (signal === 'corrupt') return 'corrupt';
  return null;
}

function textRoom(handler: XmlHandler): number {
  return handler.textRoom?.() ?? Number.POSITIVE_INFINITY;
}

export function scanXml(xml: string, handler: XmlHandler, maxTagChars: number): ScanStatus {
  const n = xml.length;
  const noAttrs: ReadonlyMap<string, string> = new Map();
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    const room = textEnd > i ? textRoom(handler) : 0;
    if (room > 0) {
      handler.text(decodeEntities(xml.slice(i, textEnd), room));
      const halted = poll(handler);
      if (halted !== null) return halted;
    }
    if (lt === -1) break;

    const next = lt + 1 < n ? xml.charCodeAt(lt + 1) : -1;
    if (next === QUESTION) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) return 'corrupt';
      i = end + 2;
      continue;
    }
    if (next === BANG) {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end === -1) return 'corrupt';
        i = end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const start = lt + 9;
        const end = xml.indexOf(']]>', start);
        if (end === -1) return 'corrupt';
        if (end > start && textRoom(handler) > 0) {
          handler.text(xml.slice(start, end));
          const halted = poll(handler);
          if (halted !== null) return halted;
        }
        i = end + 3;
        continue;
      }
      return 'corrupt';
    }

    const limit = Math.min(n, lt + 1 + maxTagChars);
    let j = lt + 1;
    let quote = 0;
    for (; j < limit; j++) {
      const c = xml.charCodeAt(j);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === QUOT || c === APOS) {
        quote = c;
      } else if (c === GT) {
        break;
      }
    }
    if (j >= limit) return 'corrupt';
    i = j + 1;

    if (next === SLASH) {
      let from = lt + 2;
      while (from < j && isSpace(xml.charCodeAt(from))) from++;
      handler.close(localName(xml.slice(from, nameEnd(xml, from, j))));
      const halted = poll(handler);
      if (halted !== null) return halted;
      continue;
    }
    const selfClosing = j - 1 > lt && xml.charCodeAt(j - 1) === SLASH;
    const bodyEnd = selfClosing ? j - 1 : j;
    const end = nameEnd(xml, lt + 1, bodyEnd);
    const local = localName(xml.slice(lt + 1, end));
    handler.open(local, end < bodyEnd ? parseAttributes(xml, end, bodyEnd) : noAttrs);
    let halted = poll(handler);
    if (halted !== null) return halted;
    if (selfClosing) {
      handler.close(local);
      halted = poll(handler);
      if (halted !== null) return halted;
    }
  }
  return 'ok';
}
