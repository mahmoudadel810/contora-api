import { z } from 'zod';
import { AppError } from './errors.js';
import { zodPipe } from './zod.pipe.js';

describe('zodPipe', () => {
  const pipe = zodPipe(
    z.object({ name: z.string().min(1), age: z.coerce.number().int() }).strict(),
  );

  it('returns parsed data', () => {
    expect(pipe.transform({ name: 'a', age: '3' }, { type: 'body' })).toEqual({
      name: 'a',
      age: 3,
    });
  });

  it('throws VALIDATION_FAILED with per-field details', () => {
    try {
      pipe.transform({ name: '', age: 'x', extra: true }, { type: 'body' });
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.getStatus()).toBe(400);
      expect(appError.code).toBe('VALIDATION_FAILED');
      const details = appError.details as Array<{
        path: string;
        message: string;
      }>;
      expect(details.map((d) => d.path)).toEqual(expect.arrayContaining(['name', 'age', 'extra']));
    }
  });
});
