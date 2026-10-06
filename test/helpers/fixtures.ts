import { as, type Actor } from './actors.js';
import type { TestApp } from './test-app.js';

export const INVOICE_TYPE = {
  name: 'Invoice',
  description: 'Supplier invoices',
  fields: [
    { key: 'supplier', label: 'Supplier', type: 'text', required: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true, min: 0 },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      required: true,
      options: ['Open', 'Paid'],
      defaultValue: 'Open',
    },
    { key: 'dueDate', label: 'Due date', type: 'date', required: false },
  ],
};

export interface Workspace {
  rootId: string;
  folderId: string;
  typeId: string;
}

export async function workspace(
  ctx: TestApp,
  admin: Actor,
  folderName = 'Invoices',
): Promise<Workspace> {
  const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
  const folder = await as(ctx, admin)
    .post('/api/v1/folders')
    .send({ name: folderName, parentId: root.body.folder.id })
    .expect(201);
  const type = await as(ctx, admin)
    .post('/api/v1/content-types')
    .send({ ...INVOICE_TYPE, name: `${INVOICE_TYPE.name} ${folderName}` })
    .expect(201);
  return { rootId: root.body.folder.id, folderId: folder.body.id, typeId: type.body.id };
}

export async function createRecord(
  ctx: TestApp,
  actor: Actor,
  ws: Workspace,
  options: {
    name?: string;
    metadata?: Record<string, unknown>;
    file?: { content: string; name: string; type?: string };
  } = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  let request = as(ctx, actor)
    .post('/api/v1/records')
    .field('name', options.name ?? 'Invoice 42')
    .field('contentTypeId', ws.typeId)
    .field('folderId', ws.folderId)
    .field('metadata', JSON.stringify(options.metadata ?? { supplier: 'Acme', amount: 120.5 }));
  if (options.file) {
    request = request.attach('file', Buffer.from(options.file.content), {
      filename: options.file.name,
      contentType: options.file.type ?? 'text/plain',
    });
  }
  const res = await request.expect(201);
  return { id: res.body.id as string, body: res.body as Record<string, unknown> };
}

export interface GrantInput {
  userId: string;
  targetType: 'folder' | 'record';
  targetId: string;
  level: 'view' | 'edit';
}

export async function grantAccess(
  ctx: TestApp,
  admin: Actor,
  grant: GrantInput,
): Promise<{ id: string } & Record<string, unknown>> {
  const res = await as(ctx, admin).put('/api/v1/access/grants').send(grant).expect(200);
  return res.body as { id: string } & Record<string, unknown>;
}

export async function grantRootEdit(ctx: TestApp, admin: Actor, member: Actor): Promise<void> {
  const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
  await grantAccess(ctx, admin, {
    userId: member.userId,
    targetType: 'folder',
    targetId: root.body.folder.id as string,
    level: 'edit',
  });
}
