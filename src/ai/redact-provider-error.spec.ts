import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { redactProviderError } from './redact-provider-error.js';

const KEY = 'fake-key-0123456789abcdef-never-real';

describe('redactProviderError', () => {
  it('keeps only name, status code and code of a provider call error', () => {
    const error = new APICallError({
      message: `Unauthorized: key ${KEY} is not valid`,
      url: `https://example.openai.azure.com/openai/deployments/x?api-key=${KEY}`,
      requestBodyValues: { messages: [{ role: 'user', content: `secret ${KEY}` }] },
      statusCode: 401,
      responseHeaders: { 'api-key': KEY, authorization: `Bearer ${KEY}` },
      responseBody: JSON.stringify({ error: { code: 'invalid_api_key', message: KEY } }),
      isRetryable: false,
      data: { error: { code: 'invalid_api_key' } },
    });
    const redacted = redactProviderError(error);
    expect(redacted).toEqual({ name: 'AI_APICallError', statusCode: 401, code: null });
    expect(JSON.stringify(redacted)).not.toContain(KEY);
  });

  it('never keeps the message of a plain error', () => {
    const redacted = redactProviderError(new Error(`boom ${KEY}`));
    expect(redacted).toEqual({ name: 'Error', statusCode: null, code: null });
    expect(JSON.stringify(redacted)).not.toContain(KEY);
  });

  it('keeps a short identifier-like code but drops one that could carry data', () => {
    const withCode = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    expect(redactProviderError(withCode).code).toBe('ECONNRESET');
    const leaky = Object.assign(new Error('x'), { code: `key=${KEY} and more text` });
    expect(redactProviderError(leaky).code).toBeNull();
  });

  it('copes with values that are not errors', () => {
    expect(redactProviderError(KEY)).toEqual({ name: 'Unknown', statusCode: null, code: null });
    expect(redactProviderError(null)).toEqual({ name: 'Unknown', statusCode: null, code: null });
  });
});
