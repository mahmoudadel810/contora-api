const MAX_NAME = 200;

export function safeFileName(original: string): string {
  const lastSegment = original.split(/[\\/]/).pop() ?? '';
  // oxlint-disable-next-line no-control-regex
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned.slice(0, MAX_NAME);
}
