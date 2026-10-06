import { parseBackfillArgs } from './search-backfill.js';

describe('parseBackfillArgs', () => {
  const id = '0123456789abcdef01234567';

  it('reads --dry-run, --tenant <id> and --all', () => {
    expect(parseBackfillArgs([])).toEqual({});
    expect(parseBackfillArgs(['--dry-run', '--tenant', id, '--all'])).toEqual({
      dryRun: true,
      tenantId: id,
      all: true,
    });
  });

  it('refuses unknown arguments and a missing or malformed tenant id', () => {
    expect(() => parseBackfillArgs(['--force'])).toThrow('Unknown argument');
    expect(() => parseBackfillArgs(['--tenant'])).toThrow('--tenant needs a tenant id');
    expect(() => parseBackfillArgs(['--tenant', 'acme'])).toThrow('--tenant needs a tenant id');
  });
});
