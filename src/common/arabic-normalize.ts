export const SEARCH_KEY_VERSION = 1;

const ALEF = 0x0627;
const YEH = 0x064a;
const HEH = 0x0647;
const WAW = 0x0648;
const KAF = 0x0643;
const DIGIT_ZERO = 0x30;
const REMOVED = -1;

function codePointAt(text: string, index: number): number {
  return text.codePointAt(index) ?? 0;
}

function widthOf(codePoint: number): number {
  return codePoint > 0xffff ? 2 : 1;
}

function foldDigit(codePoint: number): number {
  if (codePoint >= 0x0660 && codePoint <= 0x0669) return DIGIT_ZERO + (codePoint - 0x0660);
  if (codePoint >= 0x06f0 && codePoint <= 0x06f9) return DIGIT_ZERO + (codePoint - 0x06f0);
  return codePoint;
}

function isRemovedMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06ed) ||
    codePoint === 0x0640
  );
}

function foldCodePoint(codePoint: number): number {
  if (isRemovedMark(codePoint)) return REMOVED;
  switch (codePoint) {
    case 0x0622:
    case 0x0623:
    case 0x0625:
    case 0x0671:
      return ALEF;
    case 0x0649:
    case 0x0626:
    case 0x06cc:
      return YEH;
    case 0x0629:
      return HEH;
    case 0x0624:
      return WAW;
    case 0x06a9:
      return KAF;
    default:
      return foldDigit(codePoint);
  }
}

function isWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    codePoint === 0x20 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000 ||
    codePoint === 0xfeff
  );
}

function isInvisible(codePoint: number): boolean {
  if (codePoint < 0x20) return codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
  return (
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let pendingSpace = false;
  for (let index = 0; index < text.length;) {
    const codePoint = codePointAt(text, index);
    const width = widthOf(codePoint);
    if (isWhitespace(codePoint)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && parts.length > 0) parts.push(' ');
      pendingSpace = false;
      parts.push(text.slice(index, index + width));
    }
    index += width;
  }
  return parts.join('');
}

export function normalizeArabic(text: string): string {
  const parts: string[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = codePointAt(text, index);
    const width = widthOf(codePoint);
    const folded = foldCodePoint(codePoint);
    if (folded === codePoint) parts.push(text.slice(index, index + width));
    else if (folded !== REMOVED) parts.push(String.fromCharCode(folded));
    index += width;
  }
  return collapseWhitespace(parts.join('').toLowerCase());
}

export function foldDigits(text: string): string {
  const parts: string[] = [];
  for (const char of text) {
    const codePoint = codePointAt(char, 0);
    const folded = foldDigit(codePoint);
    parts.push(folded === codePoint ? char : String.fromCharCode(folded));
  }
  return parts.join('');
}

export function stripInvisibles(text: string): string {
  const parts: string[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = codePointAt(text, index);
    const width = widthOf(codePoint);
    if (!isInvisible(codePoint)) parts.push(text.slice(index, index + width));
    index += width;
  }
  return parts.join('');
}

export function searchKey(text: string): string {
  return normalizeArabic(stripInvisibles(text));
}

export function foldWithOffsets(text: string): { folded: string; offsets: number[] } {
  const parts: string[] = [];
  const offsets: number[] = [];
  let length = 0;
  let spaceAt = -1;
  for (let index = 0; index < text.length;) {
    const codePoint = codePointAt(text, index);
    const width = widthOf(codePoint);
    const folded = isInvisible(codePoint) ? REMOVED : foldCodePoint(codePoint);
    if (folded !== REMOVED) {
      if (isWhitespace(folded)) {
        if (spaceAt < 0) spaceAt = index;
      } else {
        if (spaceAt >= 0 && length > 0) {
          parts.push(' ');
          offsets.push(spaceAt);
          length += 1;
        }
        spaceAt = -1;
        const lower = (
          folded === codePoint ? text.slice(index, index + width) : String.fromCharCode(folded)
        ).toLowerCase();
        parts.push(lower);
        offsets.push(...Array.from({ length: lower.length }, () => index));
        length += lower.length;
      }
    }
    index += width;
  }
  offsets.push(text.length);
  return { folded: parts.join(''), offsets };
}
