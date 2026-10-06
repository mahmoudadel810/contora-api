import { z } from 'zod';
import {
  answer,
  filtered,
  hangs,
  providerError,
  rawText,
  ScriptedExtractionProvider,
  stalls,
  throws,
} from '../../test/helpers/scripted-extraction-ai.js';
import { callExtractionModel, type ModelRequest } from './extraction-model.js';

const schema = z
  .object({
    supplier: z
      .object({
        value: z.string().nullable(),
        confidence: z.number(),
        sourceSnippet: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const GOOD = { supplier: { value: 'Acme', confidence: 0.9, sourceSnippet: 'Supplier: Acme' } };

function request(provider: ScriptedExtractionProvider): ModelRequest {
  return {
    model: provider.model('sub'),
    system: 'system text',
    user: JSON.stringify({ fields: [], document: 'Supplier: Acme' }),
    schema,
    maxOutputTokens: 4000,
  };
}

const live = () => new AbortController().signal;

describe('callExtractionModel', () => {
  it('returns the parsed answer with usage, the model id and one call', async () => {
    const provider = new ScriptedExtractionProvider().script(answer(GOOD));
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({
      ok: true,
      output: GOOD,
      usage: { inputTokens: 120, outputTokens: 30 },
      modelId: 'scripted-extraction',
      calls: 1,
    });
  });

  it('asks for a strict JSON response, with no SDK retries and the job signal', async () => {
    const provider = new ScriptedExtractionProvider().script(answer(GOOD));
    const controller = new AbortController();
    await callExtractionModel(request(provider), controller.signal);
    const [call] = provider.calls();
    expect(call?.responseFormat).toMatchObject({ type: 'json' });
    expect((call?.responseFormat as { schema?: unknown } | undefined)?.schema).toBeDefined();
    expect(call?.providerOptions).toEqual({ openai: { strictJsonSchema: true } });
    expect(call?.maxOutputTokens).toBe(4000);
    expect(call?.abortSignal).toBeDefined();
    expect(call?.tools ?? []).toEqual([]);
  });

  it('stores missing usage as null (unmetered), never 0', async () => {
    const provider = new ScriptedExtractionProvider().script(
      rawText(JSON.stringify(GOOD), { metered: false }),
    );
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('retries once on a 503 and succeeds', async () => {
    const provider = new ScriptedExtractionProvider().script(providerError(503), answer(GOOD));
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({ ok: true, calls: 2 });
  });

  it('fails AI_UNAVAILABLE provider after a 500 twice', async () => {
    const provider = new ScriptedExtractionProvider().script(
      providerError(500),
      providerError(500),
    );
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({
      ok: false,
      code: 'AI_UNAVAILABLE',
      reason: 'provider',
      calls: 2,
    });
    expect(provider.remaining()).toBe(0);
  });

  it.each([400, 401, 403, 404])('does not retry a %s', async (status) => {
    const provider = new ScriptedExtractionProvider().script(providerError(status), answer(GOOD));
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({
      ok: false,
      code: 'AI_UNAVAILABLE',
      reason: 'provider',
      calls: 1,
    });
    expect(provider.remaining()).toBe(1);
  });

  it('retries a 429 once, waiting out retry-after (capped)', async () => {
    const provider = new ScriptedExtractionProvider().script(
      providerError(429, { 'retry-after': '0.01' }),
      answer(GOOD),
    );
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({ ok: true, calls: 2 });
  });

  it('retries a schema-parse failure once, then fails bad_output with its usage counted', async () => {
    const provider = new ScriptedExtractionProvider().script(
      rawText('not json'),
      rawText('{"x":1}'),
    );
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({
      ok: false,
      code: 'AI_UNAVAILABLE',
      reason: 'bad_output',
      calls: 2,
      usage: { inputTokens: 240, outputTokens: 60 },
    });
  });

  it('does not retry a content-filter refusal', async () => {
    const provider = new ScriptedExtractionProvider().script(filtered, answer(GOOD));
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({ ok: false, reason: 'content_filter', calls: 1 });
  });

  it('fails EXTRACTION_TIMEOUT model when the deadline fires during the call', async () => {
    const seen: { signal?: AbortSignal } = {};
    const provider = new ScriptedExtractionProvider().script(hangs(seen));
    const outcome = await callExtractionModel(request(provider), AbortSignal.timeout(50));
    expect(outcome).toMatchObject({ ok: false, code: 'EXTRACTION_TIMEOUT', reason: 'model' });
    expect(seen.signal?.aborted).toBe(true);
  });

  it('ends at the deadline even when the model ignores its signal', async () => {
    const provider = new ScriptedExtractionProvider().script(stalls());
    const outcome = await callExtractionModel(request(provider), AbortSignal.timeout(50));
    expect(outcome).toMatchObject({ ok: false, code: 'EXTRACTION_TIMEOUT' });
  });

  it('keeps nothing of a non-provider error but its name', async () => {
    const provider = new ScriptedExtractionProvider().script(
      throws(new RangeError('SENTINEL text')),
    );
    const outcome = await callExtractionModel(request(provider), live());
    expect(outcome).toMatchObject({
      ok: false,
      code: 'AI_UNAVAILABLE',
      reason: 'provider',
      calls: 1,
    });
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL');
  });
});
