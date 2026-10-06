const MAX_KEY = 40;
const FALLBACK = 'field';

function baseKeyOf(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
  const camel = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('')
    .replace(/^[^a-zA-Z]+/, '');
  return (camel.charAt(0).toLowerCase() + camel.slice(1)).slice(0, MAX_KEY);
}

export function generateFieldKey(label: string, takenKeys: ReadonlySet<string>): string {
  const base = baseKeyOf(label) || FALLBACK;
  const isTaken = (key: string) => takenKeys.has(key) || key in Object.prototype;
  if (base !== FALLBACK && !isTaken(base)) return base;
  for (let n = base === FALLBACK ? 1 : 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, MAX_KEY - suffix.length) + suffix;
    if (!isTaken(candidate)) return candidate;
  }
}
