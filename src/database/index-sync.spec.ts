import { createAllIndexes } from './index-sync.js';

function model(modelName: string, createIndexes: () => Promise<unknown>, calls: string[]) {
  return {
    modelName,
    init: async () => {
      calls.push(`init ${modelName}`);
    },
    createIndexes: async () => {
      calls.push(`index ${modelName}`);
      return createIndexes();
    },
  };
}

describe('createAllIndexes', () => {
  it('initialises and indexes every model in turn', async () => {
    const calls: string[] = [];
    const ok = async () => undefined;
    await expect(createAllIndexes([model('A', ok, calls), model('B', ok, calls)])).resolves.toBe(2);
    expect(calls).toEqual(['init A', 'index A', 'init B', 'index B']);
  });

  it('fails on the first error, naming the model, and does not go on', async () => {
    const calls: string[] = [];
    const failing = model('Record', () => Promise.reject(new Error('duplicate key')), calls);
    const later = model('Later', async () => undefined, calls);
    await expect(createAllIndexes([failing, later])).rejects.toThrow(
      'Could not create the indexes of Record: duplicate key',
    );
    expect(calls).not.toContain('init Later');
  });
});
