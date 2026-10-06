export interface RedactedProviderError {
  name: string;
  statusCode: number | null;
  code: string | null;
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/;

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null;
}

export function redactProviderError(error: unknown): RedactedProviderError {
  if (typeof error !== 'object' || error === null) {
    return { name: 'Unknown', statusCode: null, code: null };
  }
  const candidate = error as { name?: unknown; statusCode?: unknown; code?: unknown };
  const statusCode =
    typeof candidate.statusCode === 'number' && Number.isInteger(candidate.statusCode)
      ? candidate.statusCode
      : null;
  return {
    name: safeIdentifier(candidate.name) ?? 'Unknown',
    statusCode,
    code: safeIdentifier(candidate.code),
  };
}
