import { Logger } from '@nestjs/common';
import {
  MAX_STREAMS_PER_USER,
  NotificationHub,
  sseFrame,
  type EventSink,
} from './notification-hub.js';

function sink(): EventSink & { frames: string[]; ended: boolean } {
  const s = {
    frames: [] as string[],
    ended: false,
    write(chunk: string) {
      s.frames.push(chunk);
    },
    end() {
      s.ended = true;
    },
  };
  return s;
}

describe('sseFrame', () => {
  it('writes the event name and one line of JSON data, then a blank line', () => {
    expect(sseFrame('unread', { unread: 2 })).toBe('event: unread\ndata: {"unread":2}\n\n');
    expect(sseFrame('notification', { body: 'two\nlines' })).toBe(
      'event: notification\ndata: {"body":"two\\nlines"}\n\n',
    );
  });

  it('refuses an event name that could break the framing', () => {
    expect(() => sseFrame('bad\ndata: x', {})).toThrow();
    expect(() => sseFrame('', {})).toThrow();
  });
});

describe('NotificationHub', () => {
  let hub: NotificationHub;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hub = new NotificationHub();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers only to the streams of that user in that tenant', () => {
    const mine = sink();
    const otherUser = sink();
    const otherTenant = sink();
    hub.attach('t1', 'u1', mine);
    hub.attach('t1', 'u2', otherUser);
    hub.attach('t2', 'u1', otherTenant);
    hub.publish('t1', 'u1', 'unread', { unread: 1 });
    expect(mine.frames).toEqual(['event: unread\ndata: {"unread":1}\n\n']);
    expect(otherUser.frames).toEqual([]);
    expect(otherTenant.frames).toEqual([]);
  });

  it('keeps at most five streams per user: a sixth tells the oldest it was replaced and ends it', () => {
    const sinks = Array.from({ length: MAX_STREAMS_PER_USER + 1 }, () => sink());
    for (const s of sinks) hub.attach('t1', 'u1', s);
    expect(sinks.map((s) => s.ended)).toEqual([true, false, false, false, false, false]);
    expect(sinks[0]?.frames).toEqual(['event: replaced\ndata: {}\n\n']);
    hub.publish('t1', 'u1', 'ping', {});
    expect(sinks[0]?.frames).toHaveLength(1);
    expect(sinks.slice(1).every((s) => s.frames.length === 1)).toBe(true);
  });

  it('stops delivering to a detached stream and forgets users with none left', () => {
    const s = sink();
    const detach = hub.attach('t1', 'u1', s);
    expect(hub.isListening('t1', 'u1')).toBe(true);
    detach();
    detach();
    expect(hub.isListening('t1', 'u1')).toBe(false);
    hub.publish('t1', 'u1', 'unread', { unread: 0 });
    expect(s.frames).toEqual([]);
  });

  it('never throws: a failing stream is logged and the others still get the event', () => {
    const broken: EventSink = {
      write() {
        throw new Error('socket gone');
      },
      end() {
        throw new Error('socket gone');
      },
    };
    const fine = sink();
    hub.attach('t1', 'u1', broken);
    hub.attach('t1', 'u1', fine);
    expect(() => hub.publish('t1', 'u1', 'unread', { unread: 3 })).not.toThrow();
    expect(fine.frames).toHaveLength(1);
    expect(() => hub.publish('t1', 'u1', 'bad name', {})).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => hub.publish('t1', 'u1', 'unread', circular)).not.toThrow();
    expect(() => hub.onModuleDestroy()).not.toThrow();
    expect(fine.ended).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
