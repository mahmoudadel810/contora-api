const SECRET_KEY = /password|passwd|secret|token|apikey|api_key|authorization|cookie/i;

const NOT_SECRET = new Set(['inputTokens', 'outputTokens']);

export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => stripSecrets(item)) as T;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!NOT_SECRET.has(key) && SECRET_KEY.test(key)) continue;
    cleaned[key] = stripSecrets(entry);
  }
  return cleaned as T;
}
