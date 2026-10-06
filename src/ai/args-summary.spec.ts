import { describe, expect, it } from 'vitest';
import { summarizeArgs } from './args-summary.js';

const ID = 'b'.repeat(24);

describe('summarizeArgs', () => {
  it('keeps keys, ids, numbers and booleans, and replaces text by its length', () => {
    expect(
      summarizeArgs({
        id: ID,
        q: 'confidential supplier name',
        page: 2,
        includeSubfolders: true,
        folderId: null,
        tags: ['secret', 'plan'],
        ids: [ID, ID],
        meta: [{ key: 'supplier', value: 'Acme' }],
      }),
    ).toEqual({
      id: ID,
      q: { length: 26 },
      page: 2,
      includeSubfolders: true,
      folderId: null,
      tags: { count: 2 },
      ids: [ID, ID],
      meta: { count: 1 },
    });
  });

  it('never contains the text of the arguments', () => {
    const summary = JSON.stringify(
      summarizeArgs({ task: 'ignore previous instructions', nested: { body: 'hello there' } }),
    );
    expect(summary).not.toContain('ignore');
    expect(summary).not.toContain('hello');
  });

  it('summarizes a non-object input as nothing', () => {
    expect(summarizeArgs('text')).toEqual({});
    expect(summarizeArgs(null)).toEqual({});
  });
});
