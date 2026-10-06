import { normalizeArabic, stripInvisibles } from './deps.js';

export function cleanText(text: string): string {
  return stripInvisibles(text.normalize('NFKC'));
}

export function foldForMatch(text: string): string {
  return normalizeArabic(cleanText(text));
}

export function cutCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

export function cutAtLineBreak(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const lineEnd = text.lastIndexOf('\n', maxChars);
  if (lineEnd > 0) return { text: text.slice(0, lineEnd), truncated: true };
  let end = maxChars;
  const unit = text.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export function hasVisibleText(text: string, atLeast = 1): boolean {
  return text.replace(/\s+/g, '').length >= atLeast;
}
