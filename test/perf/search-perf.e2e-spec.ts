import type { Principal } from '../../src/auth/principal.js';
import { ListRecordsQuerySchema, metadataFiltersOf } from '../../src/records/records.dto.js';
import { RecordsService } from '../../src/records/records.service.js';
import { DEMO_ADMIN, DEMO_MEMBER, DEMO_PASSWORD } from '../../src/seed/demo-data.js';
import { SeedModule } from '../../src/seed/seed.module.js';
import { SeedService } from '../../src/seed/seed.service.js';
import { addMember, as, signIn, signUp, type Actor } from '../helpers/actors.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const RUNS = 5;
const SYNTHETIC_RECORDS = 10_000;
const LATIN_QUERIES = [
  'invoice',
  'globex',
  'wayne',
  'agreement',
  'q3',
  'report',
  'consulting',
  'paid',
  'zzz-no-match',
  '2026',
];
const ARABIC_QUERIES = [
  'احمد',
  'مدرسه',
  'فاتوره',
  'عقد',
  'ايجار',
  'مستشفي',
  'شركه',
  'مذكره',
  '١٢٣',
  'لا-يوجد',
];

function principalOf(actor: Actor): Principal {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    role: actor.role,
    email: actor.email,
    displayName: actor.displayName,
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function measure(ctx: TestApp, label: string, principal: Principal): Promise<void> {
  const records = ctx.app.get(RecordsService);
  const timings: Record<'latin' | 'arabic', number[]> = { latin: [], arabic: [] };
  for (const [kind, queries] of [
    ['latin', LATIN_QUERIES],
    ['arabic', ARABIC_QUERIES],
  ] as const) {
    for (const q of queries) {
      const raw = { q, pageSize: '20' };
      const query = ListRecordsQuerySchema.parse(raw);
      await records.list(principal, query, metadataFiltersOf(query));
      for (let run = 0; run < RUNS; run += 1) {
        const started = performance.now();
        await records.list(principal, query, metadataFiltersOf(query));
        timings[kind].push(performance.now() - started);
      }
    }
  }
  for (const kind of ['latin', 'arabic'] as const) {
    const sorted = [...timings[kind]].sort((a, b) => a - b);
    console.log(
      `[search-perf] ${label} ${principal.role} ${kind}: n=${sorted.length} ` +
        `p50=${percentile(sorted, 50).toFixed(2)}ms p95=${percentile(sorted, 95).toFixed(2)}ms`,
    );
  }
}

const ARABIC_WORDS = ['أحمد', 'مدرسة', 'فاتورة', 'عقد', 'إيجار', 'مستشفى', 'شركة', 'مذكرة'];
const LATIN_WORDS = ['invoice', 'globex', 'wayne', 'agreement', 'report', 'consulting', 'paid'];

function text(seed: number, arabic: boolean, length: number): string {
  const words = arabic ? ARABIC_WORDS : LATIN_WORDS;
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < length; i += 1) {
    const word = `${words[(seed + i * 7) % words.length]}${(seed * 31 + i) % 1000}`;
    parts.push(word);
    size += word.length + 1;
  }
  return parts.join(' ').slice(0, length).trim();
}

describe.runIf(process.env.SEARCH_PERF === '1')('search performance (opt-in)', () => {
  describe('(a) the seed dataset', () => {
    let ctx: TestApp;

    beforeAll(async () => {
      ctx = await createTestApp([SeedModule]);
      await ctx.app.get(SeedService).run();
    });

    afterAll(async () => {
      await ctx.stop();
    });

    it('times list searches for the admin and the member', async () => {
      const admin = await signIn(ctx, DEMO_ADMIN.email, DEMO_PASSWORD);
      const member = await signIn(ctx, DEMO_MEMBER.email, DEMO_PASSWORD);
      await measure(ctx, 'seed', principalOf(admin));
      await measure(ctx, 'seed', principalOf(member));
    }, 120_000);
  });

  describe('(b) 10,000 synthetic records in one tenant', () => {
    let ctx: TestApp;

    beforeAll(async () => {
      ctx = await createTestApp();
    });

    afterAll(async () => {
      await ctx.stop();
    });

    it('times list searches for the admin and the member', async () => {
      const admin = await signUp(ctx, { tenantName: 'Perf Co' });
      const member = await addMember(ctx, admin);
      const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
      const folderId = root.body.folder.id as string;
      const type = await as(ctx, admin)
        .post('/api/v1/content-types')
        .send({
          name: 'Perf document',
          fields: [
            { key: 'title', label: 'Title', type: 'text', required: true, maxLength: 200 },
            { key: 'notes', label: 'Notes', type: 'textarea', required: false, maxLength: 2000 },
          ],
        })
        .expect(201);
      const records = ctx.app.get(RecordsService);
      const creator = principalOf(admin);
      const started = performance.now();
      for (let i = 0; i < SYNTHETIC_RECORDS; i += 1) {
        const arabic = i % 10 < 3;
        await records.create(
          creator,
          {
            name: text(i, arabic, 200),
            contentTypeId: type.body.id as string,
            folderId,
            metadata: { title: text(i + 1, arabic, 200), notes: text(i + 2, arabic, 200) },
            comment: '',
            tags: [],
          },
          null,
        );
      }
      console.log(
        `[search-perf] created ${SYNTHETIC_RECORDS} records in ` +
          `${((performance.now() - started) / 1000).toFixed(1)} s`,
      );
      await measure(ctx, '10k', principalOf(admin));
      await measure(ctx, '10k', principalOf(member));
    }, 3_600_000);
  });
});
