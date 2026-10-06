const OBJECT_ID = /^[a-f0-9]{24}$/;

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return OBJECT_ID.test(value) ? value : { length: value.length };
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string' && OBJECT_ID.test(item))
      ? value.slice(0, 50)
      : { count: value.length };
  }
  if (typeof value === 'object') return { keys: Object.keys(value).length };
  return null;
}

export function summarizeArgs(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) summary[key] = summarizeValue(value);
  return summary;
}
