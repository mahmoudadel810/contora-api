import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import type { Response as TestResponse, Test } from 'supertest';
import { AuditEntry } from '../src/audit/audit-entry.schema.js';
import type { AuditAction } from '../src/audit/audit-action.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { RecordEntity } from '../src/records/record.schema.js';
import { ShareLink } from '../src/shares/share-link.schema.js';
import { BlobsService } from '../src/storage/blobs.service.js';
import { addMember, as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

const DAY = 24 * 60 * 60 * 1000;
const in7Days = () => new Date(Date.now() + 7 * DAY).toISOString();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const unknownToken = () => randomBytes(32).toString('base64url');

const RESOLVE = '/api/v1/public/share-link';
const UNLOCK = '/api/v1/public/share-link/unlock';
const CONTENT = '/api/v1/public/share-link/content';
const PASSWORD = 'open sesame 42';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

const PUBLIC_KEYS = [
  'expiresAt',
  'fileName',
  'inlinePreview',
  'mimeType',
  'passwordRequired',
  'sharedByName',
  'size',
].sort();

function isVarying(name: string): boolean {
  return (
    ['date', 'x-request-id', 'etag', 'content-length', 'connection', 'keep-alive'].includes(name) ||
    name.startsWith('x-ratelimit') ||
    name.startsWith('retry-after')
  );
}

function shapeOf(res: TestResponse) {
  const { requestId, ...body } = res.body as Record<string, unknown>;
  expect(typeof requestId).toBe('string');
  return {
    status: res.status,
    body,
    headers: Object.fromEntries(Object.entries(res.headers).filter(([name]) => !isVarying(name))),
  };
}

interface Created {
  id: string;
  token: string;
}

describe('public share links (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let ws: Workspace;
  let links: Model<ShareLink>;
  let records: Model<RecordEntity>;
  let audits: Model<AuditEntry>;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Public Co' });
    ws = await workspace(ctx, admin, 'Shared files');
    links = ctx.app.get<Model<ShareLink>>(getModelToken(ShareLink.name));
    records = ctx.app.get<Model<RecordEntity>>(getModelToken(RecordEntity.name));
    audits = ctx.app.get<Model<AuditEntry>>(getModelToken(AuditEntry.name));
  });

  afterAll(async () => {
    await ctx.stop();
  });

  async function fileRecord(
    name = 'Report',
    options: { content?: string; type?: string; target?: Workspace } = {},
  ): Promise<string> {
    const { id } = await createRecord(ctx, admin, options.target ?? ws, {
      name,
      file: {
        content: options.content ?? `content of ${name}`,
        name: `${name}.txt`,
        type: options.type ?? 'text/plain',
      },
    });
    return id;
  }

  async function share(
    actor: Actor,
    recordId: string,
    body: Record<string, unknown> = {},
  ): Promise<Created> {
    const res = await as(ctx, actor)
      .post(`/api/v1/records/${recordId}/share-links`)
      .send({ expiresAt: in7Days(), ...body })
      .expect(201);
    return { id: res.body.id as string, token: (res.body.url as string).split('#')[1] };
  }

  async function sharerMember(): Promise<{ member: Actor; grantId: string }> {
    const member = await addMember(ctx, admin);
    const res = await as(ctx, admin)
      .put('/api/v1/access/grants')
      .send({ userId: member.userId, targetType: 'folder', targetId: ws.folderId, level: 'edit' })
      .expect(200);
    return { member, grantId: res.body.id as string };
  }

  const withHeaders = (test: Test, token?: string, access?: string) => {
    let request = test.set('User-Agent', FIREFOX);
    if (token !== undefined) request = request.set('X-Share-Token', token);
    if (access !== undefined) request = request.set('X-Share-Access', access);
    return request;
  };
  const resolve = (token?: string, access?: string) =>
    withHeaders(ctx.http().get(RESOLVE), token, access);
  const unlock = (token: string | undefined, password: string) =>
    withHeaders(ctx.http().post(UNLOCK), token).send({ password });
  const content = (token?: string, access?: string, disposition?: 'inline' | 'attachment') =>
    withHeaders(
      ctx.http().get(disposition ? `${CONTENT}?disposition=${disposition}` : CONTENT),
      token,
      access,
    );

  const linkOf = (id: string) => links.findById(id).lean().exec();

  async function auditOf(action: AuditAction, recordId: string) {
    return audits
      .find({ action, 'resource.id': recordId })
      .sort({ createdAt: 1, _id: 1 })
      .lean()
      .exec();
  }

  const served = async (recordId: string) =>
    (await auditOf('SHARE_LINK_ACCESSED', recordId)).filter(
      (e) => (e.context as { outcome?: string }).outcome === 'served',
    );

  describe('the uniform 404', () => {
    let baseline: ReturnType<typeof shapeOf>;
    let unlockBaseline: ReturnType<typeof shapeOf>;
    let contentBaseline: ReturnType<typeof shapeOf>;

    beforeAll(async () => {
      baseline = shapeOf(await resolve(unknownToken()));
      unlockBaseline = shapeOf(await unlock(unknownToken(), PASSWORD));
      contentBaseline = shapeOf(await content(unknownToken()));
    });

    it('is a 404 NOT_FOUND "Share link not found", no-store and noindex', () => {
      for (const shape of [baseline, unlockBaseline, contentBaseline]) {
        expect(shape.status).toBe(404);
        expect(shape.body).toEqual({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Share link not found',
        });
        expect(shape.headers['cache-control']).toBe('no-store');
        expect(shape.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(shape.headers['referrer-policy']).toBe('no-referrer');
      }
    });

    const expectUniform = async (token: string | undefined) => {
      expect(shapeOf(await resolve(token))).toEqual(baseline);
      expect(shapeOf(await unlock(token, PASSWORD))).toEqual(unlockBaseline);
      expect(shapeOf(await content(token))).toEqual(contentBaseline);
    };

    it('for a missing header', async () => {
      await expectUniform(undefined);
    });

    it('for a short, long or badly spelled token, never a 400', async () => {
      const token = unknownToken();
      await expectUniform(token.slice(0, 42));
      await expectUniform(`${token}A`);
      await expectUniform(`${token.slice(0, 42)}=`);
      await expectUniform(`${token.slice(0, 42)}.`);
    });

    it('for an unknown token', async () => {
      await expectUniform(unknownToken());
    });

    it('for an expired link', async () => {
      const link = await share(admin, await fileRecord('Expired'));
      await links.updateOne({ _id: link.id }, { expiresAt: new Date(Date.now() - 1) }).exec();
      await expectUniform(link.token);
    });

    it('for a revoked link', async () => {
      const link = await share(admin, await fileRecord('Revoked'));
      await as(ctx, admin).delete(`/api/v1/share-links/${link.id}`).expect(204);
      await expectUniform(link.token);
    });

    it('for a trashed record', async () => {
      const recordId = await fileRecord('Trashed');
      const link = await share(admin, recordId);
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await expectUniform(link.token);
    });

    it('for a record trashed with its folder', async () => {
      const folder = await as(ctx, admin)
        .post('/api/v1/folders')
        .send({ name: 'Cascade', parentId: ws.folderId })
        .expect(201);
      const recordId = await fileRecord('In cascade', {
        target: { ...ws, folderId: folder.body.id as string },
      });
      const link = await share(admin, recordId);
      await as(ctx, admin).delete(`/api/v1/folders/${folder.body.id}`).expect(204);
      await expectUniform(link.token);
    });

    it('for a purged record', async () => {
      const recordId = await fileRecord('Purged');
      const link = await share(admin, recordId);
      await as(ctx, admin).delete(`/api/v1/records/${recordId}`).expect(204);
      await as(ctx, admin).delete(`/api/v1/trash/records/${recordId}`).expect(200);
      await expectUniform(link.token);
    });

    it('for a record without a file', async () => {
      const recordId = await fileRecord('Lost file');
      const link = await share(admin, recordId);
      await records.updateOne({ _id: new Types.ObjectId(recordId) }, { file: null }).exec();
      await expectUniform(link.token);
    });

    it('for a missing blob (content only; the metadata does not open the file)', async () => {
      const recordId = await fileRecord('Blob gone');
      const link = await share(admin, recordId);
      await records
        .updateOne({ _id: new Types.ObjectId(recordId) }, { 'file.blobId': new Types.ObjectId() })
        .exec();
      expect(shapeOf(await content(link.token))).toEqual(contentBaseline);
      expect(await served(recordId)).toEqual([]);
      expect((await linkOf(link.id))?.accessCount).toBe(0);
    });

    it('for a record claimed for purge', async () => {
      const recordId = await fileRecord('Claimed');
      const link = await share(admin, recordId);
      await records
        .updateOne(
          { _id: new Types.ObjectId(recordId) },
          { purgeToken: 'claimed-by-a-purge', purgeClaimedAt: new Date() },
        )
        .exec();
      await expectUniform(link.token);
    });

    it('for a suspended sharer', async () => {
      const { member } = await sharerMember();
      const link = await share(member, await fileRecord('Suspended sharer'));
      await as(ctx, admin).post(`/api/v1/members/${member.userId}/suspend`).expect(200);
      await expectUniform(link.token);
    });

    it('for a removed sharer', async () => {
      const { member } = await sharerMember();
      const link = await share(member, await fileRecord('Removed sharer'));
      await as(ctx, admin).delete(`/api/v1/members/${member.userId}`).expect(204);
      await expectUniform(link.token);
    });

    it('for a sharer who lost View (grant revoked)', async () => {
      const { member, grantId } = await sharerMember();
      const link = await share(member, await fileRecord('Lost view'));
      await resolve(link.token).expect(200);
      await as(ctx, admin).delete(`/api/v1/access/grants/${grantId}`).expect(200);
      await expectUniform(link.token);
    });

    it('for a dead password link (checked before the password)', async () => {
      const link = await share(admin, await fileRecord('Dead password'), { password: PASSWORD });
      await as(ctx, admin).delete(`/api/v1/share-links/${link.id}`).expect(204);
      await expectUniform(link.token);
      expect(shapeOf(await unlock(link.token, PASSWORD))).toEqual(unlockBaseline);
    });

    it('writes nothing and audits nothing for unknown or malformed tokens', async () => {
      const before = await audits.countDocuments().exec();
      const linksBefore = JSON.stringify(await links.find().lean().exec());
      for (const token of [undefined, 'short', unknownToken()]) {
        await resolve(token).expect(404);
        await unlock(token, PASSWORD).expect(404);
        await content(token).expect(404);
      }
      expect(await audits.countDocuments().exec()).toBe(before);
      expect(JSON.stringify(await links.find().lean().exec())).toBe(linksBefore);
    });

    it('audits a refused access to a known link at most once per 15 minutes', async () => {
      const recordId = await fileRecord('Refused');
      const link = await share(admin, recordId);
      await links.updateOne({ _id: link.id }, { expiresAt: new Date(Date.now() - 1) }).exec();
      for (let i = 0; i < 3; i += 1) await resolve(link.token).expect(404);
      await content(link.token).expect(404);
      let refused = await auditOf('SHARE_LINK_ACCESSED', recordId);
      expect(refused).toHaveLength(1);
      expect(refused[0].actor).toBeNull();
      expect(refused[0].context).toEqual({
        linkId: link.id,
        outcome: 'refused',
        reason: 'expired',
      });

      await links
        .updateOne({ _id: link.id }, { refusedAuditedAt: new Date(Date.now() - 16 * 60_000) })
        .exec();
      await resolve(link.token).expect(404);
      await resolve(link.token).expect(404);
      refused = await auditOf('SHARE_LINK_ACCESSED', recordId);
      expect(refused).toHaveLength(2);
    });
  });

  describe('a live link without a password', () => {
    it('answers the metadata only, counts the view and audits it with a null actor', async () => {
      const recordId = await fileRecord('Brochure', { content: 'hello world' });
      const link = await share(admin, recordId);
      const res = await resolve(link.token).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(PUBLIC_KEYS);
      expect(res.body).toEqual({
        passwordRequired: false,
        fileName: 'Brochure.txt',
        size: 11,
        mimeType: 'text/plain',
        sharedByName: admin.displayName,
        expiresAt: expect.any(String),
        inlinePreview: true,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['referrer-policy']).toBe('no-referrer');

      const stored = await linkOf(link.id);
      expect(stored?.accessCount).toBe(1);
      expect(stored?.lastAccessedAt).toBeInstanceOf(Date);
      const [entry] = await served(recordId);
      expect(entry.actor).toBeNull();
      expect(entry.resource).toMatchObject({ type: 'record', id: recordId, label: 'Brochure' });
      expect(entry.context).toEqual({
        linkId: link.id,
        outcome: 'served',
        kind: 'view',
        versionNumber: 1,
        uaFamily: 'firefox',
      });
    });

    it('downloads the bytes with the serving headers, and previews inline-safe types', async () => {
      const recordId = await fileRecord('Notes', { content: 'the notes' });
      const link = await share(admin, recordId);
      const res = await content(link.token).expect(200);
      expect(res.text).toBe('the notes');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.headers['content-disposition']).toBe("attachment; filename*=UTF-8''Notes.txt");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['referrer-policy']).toBe('no-referrer');

      const inline = await content(link.token, undefined, 'inline').expect(200);
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      expect((await served(recordId)).map((e) => (e.context as { kind: string }).kind)).toEqual([
        'download',
        'preview',
      ]);
      expect((await linkOf(link.id))?.accessCount).toBe(2);
    });

    it('sends HTML and SVG as attachments even when inline is asked for', async () => {
      for (const [label, type] of [
        ['html', 'text/html'],
        ['svg', 'image/svg+xml'],
      ]) {
        const recordId = await fileRecord(`Active ${label}`, {
          type,
          content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        });
        const link = await share(admin, recordId);
        const meta = await resolve(link.token).expect(200);
        expect(meta.body.inlinePreview).toBe(false);
        const res = await content(link.token, undefined, 'inline')
          .buffer(true)
          .parse((response, done) => {
            response.on('data', () => undefined);
            response.on('end', () => done(null, null));
          })
          .expect(200);
        expect(res.headers['content-disposition']).toMatch(/^attachment;/);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
        const [entry] = await served(recordId).then((all) =>
          all.filter((e) => (e.context as { kind: string }).kind !== 'view'),
        );
        expect(entry.context).toMatchObject({ kind: 'download' });
      }
    });

    it('keeps a file name with CR/LF, quotes and semicolons in one header', async () => {
      const recordId = await fileRecord('Tricky');
      await records
        .updateOne(
          { _id: new Types.ObjectId(recordId) },
          { 'file.fileName': 'a\r\nX-Injected: yes; b".txt' },
        )
        .exec();
      const link = await share(admin, recordId);
      const res = await content(link.token).expect(200);
      expect(res.headers['x-injected']).toBeUndefined();
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent('a\r\nX-Injected: yes; b".txt')}`,
      );
    });

    it('serves the current version: a link created at v2 serves v3', async () => {
      const recordId = await fileRecord('Versioned', { content: 'v1' });
      await as(ctx, admin)
        .post(`/api/v1/records/${recordId}/versions`)
        .attach('file', Buffer.from('v2'), { filename: 'Versioned.txt', contentType: 'text/plain' })
        .expect(201);
      const link = await share(admin, recordId);
      await as(ctx, admin)
        .post(`/api/v1/records/${recordId}/versions`)
        .attach('file', Buffer.from('v3'), { filename: 'Versioned.txt', contentType: 'text/plain' })
        .expect(201);
      const res = await content(link.token).expect(200);
      expect(res.text).toBe('v3');
      const [entry] = await served(recordId);
      expect(entry.context).toMatchObject({ kind: 'download', versionNumber: 3 });
    });

    it('ignores a bearer from another tenant: the same answer, a null actor', async () => {
      const recordId = await fileRecord('Bearer');
      const link = await share(admin, recordId);
      const other = await signUp(ctx, { tenantName: 'Foreign Co' });
      const otherAudits = await audits
        .countDocuments({ tenantId: new Types.ObjectId(other.tenantId) })
        .exec();
      const res = await resolve(link.token)
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      expect(res.body.fileName).toBe('Bearer.txt');
      await resolve(link.token).set('Authorization', 'Bearer not-a-jwt').expect(200);
      const entries = await served(recordId);
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.actor === null)).toBe(true);
      expect(entries.every((e) => e.tenantId.toHexString() === admin.tenantId)).toBe(true);
      expect(
        await audits.countDocuments({ tenantId: new Types.ObjectId(other.tenantId) }).exec(),
      ).toBe(otherAudits);
    });

    it('answers unlock like a live link, with an access value it does not need', async () => {
      const link = await share(admin, await fileRecord('No password'));
      const res = await unlock(link.token, 'anything').expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['access', 'accessExpiresAt', 'file']);
      expect(res.body.access).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Object.keys(res.body.file).sort()).toEqual(PUBLIC_KEYS);
    });

    it('ignores tenant and id hints in headers, and refuses them in the query (400)', async () => {
      const other = await signUp(ctx, { tenantName: 'Hint Co' });
      const recordId = await fileRecord('Hinted');
      const link = await share(admin, recordId);
      const plain = await resolve(link.token).expect(200);
      const hinted = await resolve(link.token)
        .set('X-Tenant-Id', other.tenantId)
        .set('X-Record-Id', new Types.ObjectId().toHexString())
        .set('X-Link-Id', new Types.ObjectId().toHexString())
        .expect(200);
      expect(hinted.body).toEqual(plain.body);
      await resolve(unknownToken()).set('X-Tenant-Id', admin.tenantId).expect(404);

      const hints = { tenantId: other.tenantId, recordId, linkId: link.id };
      for (const request of [
        () => resolve(link.token).query(hints),
        () => withHeaders(ctx.http().post(UNLOCK), link.token).query(hints).send({ password: 'x' }),
        () => content(link.token).query(hints),
      ]) {
        const res = await request().expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      const entries = await served(recordId);
      expect(entries.every((e) => e.tenantId.toHexString() === admin.tenantId)).toBe(true);
    });

    it('validates the unlock body and the content query', async () => {
      const link = await share(admin, await fileRecord('Validation'), { password: PASSWORD });
      for (const body of [
        {},
        { password: '' },
        { password: 'x'.repeat(129) },
        { password: 'é'.repeat(37) },
        { password: PASSWORD, extra: 1 },
      ]) {
        const res = await withHeaders(ctx.http().post(UNLOCK), link.token).send(body).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.headers['cache-control']).toBe('no-store');
      }
      const bad = await content(link.token).query({ disposition: 'open' }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('a password link', () => {
    it('asks for the password without counting, then serves with the proof; no secret is audited', async () => {
      const recordId = await fileRecord('Secret plan', { content: 'the plan' });
      const link = await share(admin, recordId, { password: PASSWORD });

      const first = await resolve(link.token).expect(200);
      expect(first.body).toEqual({ passwordRequired: true });
      expect(first.headers['cache-control']).toBe('no-store');
      expect((await linkOf(link.id))?.accessCount).toBe(0);
      expect(await auditOf('SHARE_LINK_ACCESSED', recordId)).toEqual([]);

      const required = await content(link.token).expect(403);
      expect(required.body.code).toBe('SHARE_LINK_PASSWORD_REQUIRED');

      const wrong = await unlock(link.token, 'not the password').expect(403);
      expect(wrong.body.code).toBe('SHARE_LINK_PASSWORD_INCORRECT');
      const [failed] = await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId);
      expect(failed.actor).toBeNull();
      expect(failed.context).toEqual({ linkId: link.id, failuresInWindow: 1, locked: false });

      const unlocked = await unlock(link.token, PASSWORD).expect(200);
      expect(unlocked.headers['cache-control']).toBe('no-store');
      const access = unlocked.body.access as string;
      expect(access).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const expiresIn = Date.parse(unlocked.body.accessExpiresAt as string) - Date.now();
      expect(expiresIn).toBeGreaterThan(29 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(30 * 60_000);
      expect(Object.keys(unlocked.body.file).sort()).toEqual(PUBLIC_KEYS);
      expect(unlocked.body.file).toMatchObject({
        passwordRequired: false,
        fileName: 'Secret plan.txt',
      });

      const stored = await linkOf(link.id);
      expect(stored?.proofs.map((p) => p.hash)).toEqual([sha256(access)]);
      expect(JSON.stringify(stored)).not.toContain(access);

      const meta = await resolve(link.token, access).expect(200);
      expect(Object.keys(meta.body).sort()).toEqual(PUBLIC_KEYS);
      const file = await content(link.token, access).expect(200);
      expect(file.text).toBe('the plan');
      expect((await linkOf(link.id))?.accessCount).toBe(2);

      const all = JSON.stringify(
        await audits
          .find({ tenantId: new Types.ObjectId(admin.tenantId) })
          .lean()
          .exec(),
      );
      for (const secret of [
        link.token,
        sha256(link.token),
        access,
        sha256(access),
        PASSWORD,
        stored?.passwordHash ?? 'unset',
      ]) {
        expect(all).not.toContain(secret);
      }
    });

    it('refuses a proof issued for another link', async () => {
      const a = await share(admin, await fileRecord('Link A'), { password: PASSWORD });
      const b = await share(admin, await fileRecord('Link B'), { password: PASSWORD });
      const { access } = (await unlock(a.token, PASSWORD).expect(200)).body as { access: string };
      expect((await resolve(b.token, access).expect(200)).body).toEqual({ passwordRequired: true });
      const res = await content(b.token, access).expect(403);
      expect(res.body.code).toBe('SHARE_LINK_PASSWORD_REQUIRED');
      expect((await linkOf(b.id))?.accessCount).toBe(0);
    });

    it('refuses an expired proof', async () => {
      const link = await share(admin, await fileRecord('Old proof'), { password: PASSWORD });
      const { access } = (await unlock(link.token, PASSWORD).expect(200)).body as {
        access: string;
      };
      await links
        .updateOne({ _id: link.id }, { 'proofs.0.expiresAt': new Date(Date.now() - 1) })
        .exec();
      expect((await resolve(link.token, access).expect(200)).body).toEqual({
        passwordRequired: true,
      });
      await content(link.token, access).expect(403);
    });

    it('keeps at most 20 proofs: the oldest stops working', async () => {
      const link = await share(admin, await fileRecord('Many viewers'), { password: PASSWORD });
      const proofs: string[] = [];
      for (let i = 0; i < 21; i += 1) {
        await links
          .updateOne({ _id: link.id }, { failedCount: 0, failWindowStartedAt: null })
          .exec();
        const res = await unlock(link.token, PASSWORD).expect(200);
        proofs.push((res.body as { access: string }).access);
      }
      const stored = await linkOf(link.id);
      expect(stored?.proofs.map((p) => p.hash)).toEqual(proofs.slice(1).map(sha256));
      expect((await resolve(link.token, proofs[0]).expect(200)).body).toEqual({
        passwordRequired: true,
      });
      expect((await resolve(link.token, proofs[20]).expect(200)).body.passwordRequired).toBe(false);
    });

    it('refunds right passwords: 12 right unlocks never lock, 10 wrong ones still do', async () => {
      const recordId = await fileRecord('Budget');
      const link = await share(admin, recordId, { password: PASSWORD });
      for (let i = 0; i < 12; i += 1) await unlock(link.token, PASSWORD).expect(200);
      let stored = await linkOf(link.id);
      expect(stored?.lockedUntil).toBeNull();
      expect(stored?.failedCount).toBe(0);
      expect(stored?.failWindowStartedAt).toBeInstanceOf(Date);
      expect(await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId)).toEqual([]);

      for (let i = 1; i < 10; i += 1) await unlock(link.token, `wrong ${i}`).expect(403);
      const tenth = await unlock(link.token, 'wrong 10').expect(429);
      expect(tenth.body.code).toBe('SHARE_LINK_LOCKED');
      stored = await linkOf(link.id);
      expect(stored?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      const failures = await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId);
      expect(failures).toHaveLength(10);
      expect(failures[9].context).toMatchObject({ failuresInWindow: 10, locked: true });
    });

    it('locks after 10 wrong passwords: 429 even for the right one, audited once as locked', async () => {
      const recordId = await fileRecord('Locked');
      const link = await share(admin, recordId, { password: PASSWORD });
      for (let i = 1; i < 10; i += 1) {
        const res = await unlock(link.token, `wrong ${i}`).expect(403);
        expect(res.body.code).toBe('SHARE_LINK_PASSWORD_INCORRECT');
      }
      const tenth = await unlock(link.token, 'wrong 10').expect(429);
      expect(tenth.body.code).toBe('SHARE_LINK_LOCKED');
      expect(tenth.headers['cache-control']).toBe('no-store');
      const right = await unlock(link.token, PASSWORD).expect(429);
      expect(right.body.code).toBe('SHARE_LINK_LOCKED');

      const failures = await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId);
      expect(failures).toHaveLength(10);
      expect(failures.map((e) => (e.context as { locked: boolean }).locked)).toEqual([
        ...Array.from({ length: 9 }, () => false),
        true,
      ]);
      expect(failures[9].context).toMatchObject({ failuresInWindow: 10 });
      const stored = await linkOf(link.id);
      expect(stored?.lockedUntil?.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(stored?.proofs).toEqual([]);

      await links.updateOne({ _id: link.id }, { lockedUntil: new Date(Date.now() - 1) }).exec();
      await unlock(link.token, PASSWORD).expect(200);
    });
  });

  describe('races', () => {
    it('a revoke landing while the blob opens: 404, the stream destroyed, nothing served', async () => {
      const recordId = await fileRecord('Race blob');
      const link = await share(admin, recordId);
      const blobs = ctx.app.get(BlobsService);
      const open = blobs.open.bind(blobs);
      const seen: { opened?: Readable } = {};
      const spy = vi.spyOn(blobs, 'open').mockImplementationOnce(async (...args) => {
        const opened = await open(...args);
        seen.opened = opened;
        await as(ctx, admin).delete(`/api/v1/share-links/${link.id}`).expect(204);
        return opened;
      });
      try {
        const res = await content(link.token).expect(404);
        expect(spy).toHaveBeenCalled();
        expect(res.body.message).toBe('Share link not found');
      } finally {
        spy.mockRestore();
      }
      expect(seen.opened?.destroyed).toBe(true);
      expect(await served(recordId)).toEqual([]);
      expect((await linkOf(link.id))?.accessCount).toBe(0);
    });

    function holdCompares() {
      const auth = ctx.app.get(AuthService);
      const compare = auth.comparePassword.bind(auth);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = { compares: 0 };
      const spy = vi.spyOn(auth, 'comparePassword').mockImplementation(async (password, hash) => {
        if (hash !== null) {
          state.compares += 1;
          await gate;
        }
        return compare(password, hash);
      });
      return { spy, state, release: () => release() };
    }

    it('15 concurrent wrong unlocks: at most 10 compares, one lock, the rest 429', async () => {
      const recordId = await fileRecord('Race reserve');
      const link = await share(admin, recordId, { password: PASSWORD });
      const held = holdCompares();
      try {
        let settled = 0;
        const pending = Array.from({ length: 15 }, (_, i) =>
          unlock(link.token, `wrong ${i}`).then((res) => {
            settled += 1;
            return res;
          }),
        );
        await vi.waitFor(() => expect(held.state.compares + settled).toBe(15), {
          timeout: 10_000,
        });
        expect(held.state.compares).toBeLessThanOrEqual(10);
        held.release();
        const results = await Promise.all(pending);
        const compares = held.state.compares;
        const forbidden = results.filter((r) => r.status === 403);
        const limited = results.filter((r) => r.status === 429);
        expect(forbidden).toHaveLength(compares - 1);
        expect(limited).toHaveLength(15 - (compares - 1));
        for (const res of limited) expect(res.body.code).toBe('SHARE_LINK_LOCKED');
        for (const res of forbidden) expect(res.body.code).toBe('SHARE_LINK_PASSWORD_INCORRECT');
      } finally {
        held.spy.mockRestore();
      }
      const failures = await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId);
      expect(failures.filter((e) => (e.context as { locked: boolean }).locked)).toHaveLength(1);
      expect((await linkOf(link.id))?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
    });

    it('sets the lock exactly once when attempts race the 10th (deterministic)', async () => {
      const recordId = await fileRecord('Race lock');
      const link = await share(admin, recordId, { password: PASSWORD });
      for (let i = 1; i < 10; i += 1) await unlock(link.token, `wrong ${i}`).expect(403);
      const held = holdCompares();
      try {
        const tenth = unlock(link.token, 'wrong 10').then((res) => res);
        await vi.waitFor(() => expect(held.state.compares).toBe(1));
        for (const password of ['late wrong', PASSWORD]) {
          const res = await unlock(link.token, password).expect(429);
          expect(res.body.code).toBe('SHARE_LINK_LOCKED');
        }
        expect(held.state.compares).toBe(1);
        held.release();
        const res = await tenth;
        expect(res.status).toBe(429);
        expect(res.body.code).toBe('SHARE_LINK_LOCKED');
      } finally {
        held.spy.mockRestore();
      }
      const failures = await auditOf('SHARE_LINK_PASSWORD_FAILED', recordId);
      expect(failures).toHaveLength(10);
      expect(failures.filter((e) => (e.context as { locked: boolean }).locked)).toHaveLength(1);
      expect((await linkOf(link.id))?.proofs).toEqual([]);
      const right = await unlock(link.token, PASSWORD).expect(429);
      expect(right.body.code).toBe('SHARE_LINK_LOCKED');
    });

    it('does not compare at all on a locked link, even with the right password', async () => {
      const link = await share(admin, await fileRecord('Locked no compare'), {
        password: PASSWORD,
      });
      await links
        .updateOne({ _id: link.id }, { lockedUntil: new Date(Date.now() + 60_000) })
        .exec();
      const spy = vi.spyOn(ctx.app.get(AuthService), 'comparePassword');
      try {
        const res = await unlock(link.token, PASSWORD).expect(429);
        expect(res.body.code).toBe('SHARE_LINK_LOCKED');
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('runs exactly one dummy compare for an unknown or dead token', async () => {
      const dead = await share(admin, await fileRecord('Dead compare'), { password: PASSWORD });
      await as(ctx, admin).delete(`/api/v1/share-links/${dead.id}`).expect(204);
      for (const token of [unknownToken(), 'malformed', dead.token]) {
        const spy = vi.spyOn(ctx.app.get(AuthService), 'comparePassword');
        try {
          await unlock(token, PASSWORD).expect(404);
          expect(spy).toHaveBeenCalledTimes(1);
          expect(spy).toHaveBeenCalledWith(PASSWORD, null);
        } finally {
          spy.mockRestore();
        }
      }
    });

    it('a proof dropped while the blob opens: 404, the stream destroyed, nothing served', async () => {
      const recordId = await fileRecord('Race proof');
      const link = await share(admin, recordId, { password: PASSWORD });
      const { access } = (await unlock(link.token, PASSWORD).expect(200)).body as {
        access: string;
      };
      const blobs = ctx.app.get(BlobsService);
      const open = blobs.open.bind(blobs);
      const seen: { opened?: Readable } = {};
      const spy = vi.spyOn(blobs, 'open').mockImplementationOnce(async (...args) => {
        const opened = await open(...args);
        seen.opened = opened;
        await links.updateOne({ _id: link.id }, { $set: { proofs: [] } }).exec();
        return opened;
      });
      try {
        const res = await content(link.token, access).expect(404);
        expect(spy).toHaveBeenCalled();
        expect(res.body.message).toBe('Share link not found');
      } finally {
        spy.mockRestore();
      }
      expect(seen.opened?.destroyed).toBe(true);
      expect(await served(recordId)).toEqual([]);
      expect((await linkOf(link.id))?.accessCount).toBe(0);
    });

    it('destroys the stream when the served audit cannot be written', async () => {
      const recordId = await fileRecord('Audit fails');
      const link = await share(admin, recordId);
      const blobs = ctx.app.get(BlobsService);
      const open = blobs.open.bind(blobs);
      const seen: { opened?: Readable } = {};
      const openSpy = vi.spyOn(blobs, 'open').mockImplementationOnce(async (...args) => {
        const opened = await open(...args);
        seen.opened = opened;
        return opened;
      });
      const audit = ctx.app.get(AuditService);
      const auditSpy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit down'));
      try {
        await content(link.token).expect(500);
        expect(auditSpy).toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
        auditSpy.mockRestore();
      }
      expect(seen.opened?.destroyed).toBe(true);
    });

    it('a lock landing during a right compare: 429, and the refund leaves the count at 0', async () => {
      const link = await share(admin, await fileRecord('Race refund'), { password: PASSWORD });
      for (let i = 1; i < 9; i += 1) await unlock(link.token, `wrong ${i}`).expect(403);
      const auth = ctx.app.get(AuthService);
      const compare = auth.comparePassword.bind(auth);
      const spy = vi
        .spyOn(auth, 'comparePassword')
        .mockImplementationOnce(async (password, hash) => {
          const wrong = await unlock(link.token, 'wrong 10').expect(429);
          expect(wrong.body.code).toBe('SHARE_LINK_LOCKED');
          return compare(password, hash);
        });
      try {
        const res = await unlock(link.token, PASSWORD).expect(429);
        expect(spy).toHaveBeenCalled();
        expect(res.body.code).toBe('SHARE_LINK_LOCKED');
      } finally {
        spy.mockRestore();
      }
      const stored = await linkOf(link.id);
      expect(stored?.failedCount).toBe(0);
      expect(stored?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(stored?.proofs).toEqual([]);
    });

    it('a revoke landing during the password compare makes the unlock 404', async () => {
      const link = await share(admin, await fileRecord('Race revoke'), { password: PASSWORD });
      const auth = ctx.app.get(AuthService);
      const compare = auth.comparePassword.bind(auth);
      const spy = vi
        .spyOn(auth, 'comparePassword')
        .mockImplementationOnce(async (password, hash) => {
          await as(ctx, admin).delete(`/api/v1/share-links/${link.id}`).expect(204);
          return compare(password, hash);
        });
      try {
        const res = await unlock(link.token, PASSWORD).expect(404);
        expect(spy).toHaveBeenCalled();
        expect(res.body.message).toBe('Share link not found');
      } finally {
        spy.mockRestore();
      }
      expect((await linkOf(link.id))?.proofs).toEqual([]);
    });
  });
});

describe('public share links at the default throttle (e2e)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp([], { AUTH_RATE_LIMIT: '20' });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('answers the 11th wrong password from one address with SHARE_LINK_LOCKED, not RATE_LIMITED', async () => {
    const admin = await signUp(ctx, { tenantName: 'Throttle Co' });
    const ws = await workspace(ctx, admin, 'Throttled');
    const { id } = await createRecord(ctx, admin, ws, {
      name: 'Guarded',
      file: { content: 'guarded', name: 'guarded.txt' },
    });
    const created = await as(ctx, admin)
      .post(`/api/v1/records/${id}/share-links`)
      .send({ expiresAt: in7Days(), password: PASSWORD })
      .expect(201);
    const token = (created.body.url as string).split('#')[1];
    const attempt = () =>
      ctx.http().post(UNLOCK).set('X-Share-Token', token).send({ password: 'wrong guess' });
    for (let i = 1; i < 10; i += 1) await attempt().expect(403);
    expect((await attempt().expect(429)).body.code).toBe('SHARE_LINK_LOCKED');
    const eleventh = await attempt().expect(429);
    expect(eleventh.body.code).toBe('SHARE_LINK_LOCKED');

    for (let i = 12; i <= 20; i += 1) await attempt().expect(429);
    const limited = await attempt().expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});
