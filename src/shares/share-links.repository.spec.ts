import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));
}

describe('share link tenant isolation', () => {
  it('reads the model directly only in findByTokenHashAcrossTenants', () => {
    const uses = sources().flatMap(({ name, text }) =>
      [...text.matchAll(/this\.model\./g)].map(() => name),
    );
    expect(uses).toEqual(['share-links.repository.ts']);
    const repository = sources().find((s) => s.name === 'share-links.repository.ts')!.text;
    const method = repository.slice(repository.indexOf('findByTokenHashAcrossTenants('));
    const body = method.slice(0, method.indexOf('\n  }'));
    expect(body).toContain('this.model.findOne({ tokenHash })');
  });

  it('never injects a raw model outside the repository', () => {
    const injecting = sources()
      .filter(({ text }) => /@InjectModel\(/.test(text))
      .map(({ name }) => name);
    expect(injecting).toEqual(['share-links.repository.ts']);
  });
});
