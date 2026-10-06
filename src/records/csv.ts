const FORMULA_START = /^[=+\-@\t\r]/;

function textOf(value: unknown): string {
  if (typeof value === 'string') return FORMULA_START.test(value) ? `'${value}` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = textOf(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}
