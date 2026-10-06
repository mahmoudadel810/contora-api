import { as, signUp, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

function rows(text: string): string[] {
  return text.replace(/^﻿/, '').trimEnd().split('\r\n');
}

describe('CSV export (e2e)', () => {
  let ctx: TestApp;
  let admin: Actor;
  let other: Actor;
  let ws: Workspace;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await signUp(ctx, { tenantName: 'Export Co', displayName: 'Ex Admin' });
    other = await signUp(ctx, { tenantName: 'Other Co' });
    ws = await workspace(ctx, admin);
    await createRecord(ctx, admin, ws, {
      name: 'Invoice, with comma',
      metadata: { supplier: '=HYPERLINK("http://evil")', amount: 10 },
    });
    await createRecord(ctx, admin, ws, {
      name: 'Paid one',
      metadata: { supplier: 'Globex', amount: 20, status: 'Paid' },
    });
  });

  afterAll(async () => {
    await ctx.stop();
  });

  it('exports the filtered search with one column per field and audits it', async () => {
    const res = await as(ctx, admin)
      .get(`/api/v1/records/export?contentTypeId=${ws.typeId}&sort=name&order=asc`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="records-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    expect(res.headers['x-export-count']).toBe('2');
    const lines = rows(res.text);
    expect(lines[0]).toBe(
      'Name,Content type,Folder,Version,Tags,File name,File size,Created,Created by,Updated,Updated by,Checked out by,Supplier,Amount,Status,Due date',
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^"Invoice, with comma",Invoice Invoices,Invoices,1,,,,/);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")",10,Open,`);
    const filtered = await as(ctx, admin)
      .get('/api/v1/records/export?meta.status=Paid')
      .expect(200);
    const paid = rows(filtered.text);
    expect(paid).toHaveLength(2);
    expect(paid[0].endsWith(',Metadata')).toBe(true);
    const audit = await as(ctx, admin).get('/api/v1/audit?action=RECORDS_EXPORTED').expect(200);
    expect(audit.body.items[0].context).toMatchObject({
      count: 1,
      truncated: false,
      filters: { metadata: { status: 'Paid' } },
    });
  });

  it('only ever exports the caller tenant', async () => {
    const res = await as(ctx, other).get('/api/v1/records/export').expect(200);
    expect(rows(res.text)).toHaveLength(1);
    await as(ctx, other).get(`/api/v1/records/export?folderId=${ws.folderId}`).expect(404);
    await ctx.http().get('/api/v1/records/export').expect(401);
  });
});
