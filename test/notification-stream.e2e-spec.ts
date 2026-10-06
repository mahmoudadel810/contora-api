import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/auth/auth.service.js';
import type { Principal } from '../src/auth/principal.js';
import { NotificationHub } from '../src/notifications/notification-hub.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { as, DEFAULT_PASSWORD, signIn, signUp, uniqueEmail, type Actor } from './helpers/actors.js';
import { createRecord, workspace, type Workspace } from './helpers/fixtures.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

interface OpenStream {
  status: number;
  headers: Headers;
  frames: Frame[];
  ended: Promise<void>;
  isEnded: () => boolean;
  close: () => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(20);
  }
}

function parseBlock(block: string): Frame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event: ')) event = line.slice('event: '.length);
    if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
  }
  return data.length === 0
    ? null
    : { event, data: JSON.parse(data.join('\n')) as Record<string, unknown> };
}

describe('live notifications over Server-Sent Events (e2e)', () => {
  let ctx: TestApp;
  let base: string;
  let admin: Actor;
  let bob: Actor;
  let carol: Actor;
  let dave: Actor;
  let outsider: Actor;
  let ws: Workspace;
  const opened: OpenStream[] = [];

  async function open(accessToken: string): Promise<OpenStream> {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/notifications/stream`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    const frames: Frame[] = [];
    let finished = false;
    const ended = (async () => {
      if (!res.body || res.status !== 200) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const frame = parseBlock(buffer.slice(0, cut));
            if (frame) frames.push(frame);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch {}
    })().finally(() => {
      finished = true;
    });
    const stream: OpenStream = {
      status: res.status,
      headers: res.headers,
      frames,
      ended,
      isEnded: () => finished,
      close: () => controller.abort(),
    };
    opened.push(stream);
    return stream;
  }

  const events = (stream: OpenStream, name: string) =>
    stream.frames.filter((frame) => frame.event === name);

  async function person(displayName: string): Promise<Actor> {
    const email = uniqueEmail('live');
    await ctx.app.get(AuthService).createMember(admin.tenantId, {
      email,
      password: DEFAULT_PASSWORD,
      displayName,
      role: 'member',
    });
    const actor = await signIn(ctx, email, DEFAULT_PASSWORD);
    const root = await as(ctx, admin).get('/api/v1/folders/root').expect(200);
    await as(ctx, admin)
      .put('/api/v1/access/grants')
      .send({
        userId: actor.userId,
        targetType: 'folder',
        targetId: root.body.folder.id as string,
        level: 'edit',
      })
      .expect(200);
    return actor;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    const server = ctx.app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await signUp(ctx, { tenantName: 'Live Co', displayName: 'Ada Admin' });
    ws = await workspace(ctx, admin);
    bob = await person('Bob Builder');
    carol = await person('Carol Clerk');
    dave = await person('Dave Diver');
    outsider = await signUp(ctx, { tenantName: 'Elsewhere Co', displayName: 'Olga Other' });
  });

  afterAll(async () => {
    for (const stream of opened) stream.close();
    await ctx.stop();
  });

  it('opens an unbuffered event stream that starts with the unread count', async () => {
    const unread = (await as(ctx, carol).get('/api/v1/notifications/unread-count').expect(200)).body
      .unread as number;
    const stream = await open(carol.token);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(stream.headers.get('cache-control')).toBe('no-store');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');
    await eventually(() => stream.frames.length > 0, 'the ready frame');
    expect(stream.frames[0]).toEqual({ event: 'ready', data: { unread } });
    stream.close();
  });

  it('refuses a missing or bad token with a JSON 401, not a stream', async () => {
    const res = await fetch(`${base}/api/v1/notifications/stream`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    const bad = await fetch(`${base}/api/v1/notifications/stream`, {
      headers: { Authorization: 'Bearer not-a-token' },
    });
    expect(bad.status).toBe(401);
    await bad.text();
  });

  it('pushes a new notification to its recipient only: not to another user, not to another tenant', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Pushed' });
    const carolStream = await open(carol.token);
    const daveStream = await open(dave.token);
    const outsiderStream = await open(outsider.token);
    const adminStream = await open(admin.token);
    await eventually(
      () =>
        [carolStream, daveStream, outsiderStream, adminStream].every((s) => s.frames.length > 0),
      'every ready frame',
    );

    const res = await as(ctx, bob)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: `Look @{user:${carol.userId}}` })
      .expect(201);

    await eventually(() => events(carolStream, 'notification').length === 1, 'Carol’s push');
    const unread = (await as(ctx, carol).get('/api/v1/notifications/unread-count').expect(200)).body
      .unread as number;
    expect(events(carolStream, 'notification')[0]?.data).toMatchObject({
      item: {
        kind: 'MENTION',
        title: 'Bob Builder mentioned you on "Pushed"',
        body: 'Look @Carol Clerk',
        recordId: id,
        commentId: res.body.id,
        read: false,
      },
      unread,
    });
    await eventually(() => events(adminStream, 'notification').length === 1, 'Alice’s push');
    expect(events(adminStream, 'notification')[0]?.data).toMatchObject({
      item: { kind: 'COMMENT_ON_RECORD', commentId: res.body.id },
    });
    await wait(200);
    expect(daveStream.frames.map((f) => f.event)).toEqual(['ready']);
    expect(outsiderStream.frames.map((f) => f.event)).toEqual(['ready']);
    expect(JSON.stringify(carolStream.frames)).not.toContain('@{user:');
    for (const stream of [carolStream, daveStream, outsiderStream, adminStream]) stream.close();
  });

  it('tells every open stream of the user the new unread count after a read change', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Read me' });
    await as(ctx, bob)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: `Two for @{user:${dave.userId}}` })
      .expect(201);
    await as(ctx, bob)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: `And another @{user:${dave.userId}}` })
      .expect(201);
    const first = await open(dave.token);
    const second = await open(dave.token);
    const carolStream = await open(carol.token);
    await eventually(
      () => [first, second, carolStream].every((s) => s.frames.length > 0),
      'ready frames',
    );
    const items = (await as(ctx, dave).get('/api/v1/notifications?unread=true').expect(200)).body
      .items as Array<{ id: string }>;
    const before = items.length;
    expect(before).toBeGreaterThanOrEqual(2);

    await as(ctx, dave).post(`/api/v1/notifications/${items[0]?.id}/read`).expect(204);
    await eventually(
      () => [first, second].every((s) => events(s, 'unread').length === 1),
      'unread after one read',
    );
    expect(events(first, 'unread')[0]?.data).toEqual({ unread: before - 1 });

    await as(ctx, dave).post('/api/v1/notifications/read-all').expect(204);
    await eventually(
      () => [first, second].every((s) => events(s, 'unread').length === 2),
      'unread after read-all',
    );
    expect(events(second, 'unread')[1]?.data).toEqual({ unread: 0 });
    expect(events(carolStream, 'unread')).toEqual([]);
    for (const stream of [first, second, carolStream]) stream.close();
  });

  it('keeps at most five streams per user: a sixth tells the oldest it was replaced and closes it', async () => {
    const erin = await person('Erin Editor');
    const streams: OpenStream[] = [];
    for (let i = 0; i < 6; i += 1) {
      const stream = await open(erin.token);
      await eventually(() => stream.frames.length > 0, `ready frame ${i + 1}`);
      streams.push(stream);
    }
    await streams[0]?.ended;
    await wait(100);
    expect(streams.map((s) => s.isEnded())).toEqual([true, false, false, false, false, false]);
    expect(streams[0]?.frames).toEqual([
      expect.objectContaining({ event: 'ready' }),
      { event: 'replaced', data: {} },
    ]);
    expect(streams.slice(1).every((s) => events(s, 'replaced').length === 0)).toBe(true);

    const { id } = await createRecord(ctx, admin, ws, { name: 'Many tabs' });
    await as(ctx, bob)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: `Hello @{user:${erin.userId}}` })
      .expect(201);
    await eventually(
      () => streams.slice(1).every((s) => events(s, 'notification').length === 1),
      'pushes to the five open streams',
    );
    expect(events(streams[0] as OpenStream, 'notification')).toEqual([]);
    for (const stream of streams) stream.close();
  });

  it('tells the owners’ streams when a deleted comment’s notifications lose their text', async () => {
    const { id } = await createRecord(ctx, admin, ws, { name: 'Taken back' });
    const carolStream = await open(carol.token);
    const daveStream = await open(dave.token);
    await eventually(
      () => carolStream.frames.length > 0 && daveStream.frames.length > 0,
      'ready frames',
    );
    const res = await as(ctx, bob)
      .post(`/api/v1/records/${id}/comments`)
      .send({ body: `Private @{user:${carol.userId}}` })
      .expect(201);
    const commentId = res.body.id as string;
    await eventually(() => events(carolStream, 'notification').length === 1, 'Carol’s push');
    await as(ctx, bob).delete(`/api/v1/records/${id}/comments/${commentId}`).expect(204);
    await eventually(() => events(carolStream, 'cleared').length === 1, 'the cleared frame');
    expect(events(carolStream, 'cleared')[0]?.data).toEqual({ commentId });
    await wait(200);
    expect(daveStream.frames.map((f) => f.event)).toEqual(['ready']);
    carolStream.close();
    daveStream.close();
  });

  it('does not leave a stream behind when the client hangs up while it is being set up', async () => {
    const hub = ctx.app.get(NotificationHub);
    const service = ctx.app.get(NotificationsService);
    const hana = await person('Hana Hangup');
    const unreadCount = service.unreadCount.bind(service);
    let entered!: () => void;
    const inSetup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi
      .spyOn(service, 'unreadCount')
      .mockImplementationOnce(async (principal: Principal) => {
        entered();
        await released;
        return unreadCount(principal);
      });
    try {
      const controller = new AbortController();
      const pending = fetch(`${base}/api/v1/notifications/stream`, {
        headers: { Authorization: `Bearer ${hana.token}` },
        signal: controller.signal,
      }).catch(() => undefined);
      await inSetup;
      controller.abort();
      await pending;
      await wait(100);
      release();
      await wait(200);
      expect(spy).toHaveBeenCalled();
      expect(hub.isListening(hana.tenantId, hana.userId)).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('limits stream opens to 30 a minute per user', async () => {
    const ivan = await person('Ivan Impatient');
    for (let i = 0; i < 30; i += 1) {
      const stream = await open(ivan.token);
      expect(stream.status).toBe(200);
      stream.close();
    }
    const refused = await fetch(`${base}/api/v1/notifications/stream`, {
      headers: { Authorization: `Bearer ${ivan.token}` },
    });
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { code: string }).code).toBe('RATE_LIMITED');
    const other = await open(carol.token);
    expect(other.status).toBe(200);
    other.close();
  });

  it('forgets a stream when the client disconnects', async () => {
    const hub = ctx.app.get(NotificationHub);
    const frank = await person('Frank Fresh');
    const stream = await open(frank.token);
    await eventually(() => stream.frames.length > 0, 'the ready frame');
    expect(hub.isListening(frank.tenantId, frank.userId)).toBe(true);
    stream.close();
    await eventually(() => !hub.isListening(frank.tenantId, frank.userId), 'the hub to forget it');
  });

  it('ends the stream when the access token expires', async () => {
    const gina = await person('Gina Short');
    const shortLived = ctx.app
      .get(JwtService)
      .sign({ sub: gina.userId, tid: gina.tenantId, iat: Date.now() / 1000 }, { expiresIn: 2 });
    const startedAt = Date.now();
    const expiring = await open(shortLived);
    const lasting = await open(gina.token);
    await eventually(
      () => expiring.frames.length > 0 && lasting.frames.length > 0,
      'the ready frames',
    );
    await expiring.ended;
    const lived = Date.now() - startedAt;
    expect(lived).toBeGreaterThan(500);
    expect(lived).toBeLessThan(3500);
    await wait(100);
    expect(lasting.isEnded()).toBe(false);
    lasting.close();
  });
});
