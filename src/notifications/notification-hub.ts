import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

export interface EventSink {
  write(chunk: string): void;
  end(): void;
}

export const MAX_STREAMS_PER_USER = 5;

export function sseFrame(event: string, data: unknown): string {
  if (!/^[A-Za-z][\w.-]*$/.test(event)) throw new Error(`Invalid event name: ${event}`);
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

@Injectable()
export class NotificationHub implements OnModuleDestroy {
  private readonly logger = new Logger('NotificationHub');
  private readonly streams = new Map<string, EventSink[]>();

  attach(tenantId: string, userId: string, sink: EventSink): () => void {
    const key = keyOf(tenantId, userId);
    const sinks = this.streams.get(key) ?? [];
    sinks.push(sink);
    this.streams.set(key, sinks);
    while (sinks.length > MAX_STREAMS_PER_USER) {
      const oldest = sinks.shift();
      if (oldest) this.evict(oldest);
    }
    return () => this.detach(key, sink);
  }

  isListening(tenantId: string, userId: string): boolean {
    return (this.streams.get(keyOf(tenantId, userId))?.length ?? 0) > 0;
  }

  publish(tenantId: string, userId: string, event: string, data: unknown): void {
    try {
      const sinks = this.streams.get(keyOf(tenantId, userId));
      if (!sinks || sinks.length === 0) return;
      const frame = sseFrame(event, data);
      for (const sink of sinks.slice()) {
        try {
          sink.write(frame);
        } catch (error) {
          this.logger.warn(`Could not write ${event} to a stream: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Could not publish ${event}: ${messageOf(error)}`);
    }
  }

  onModuleDestroy(): void {
    const all = [...this.streams.values()].flat();
    this.streams.clear();
    for (const sink of all) this.endQuietly(sink);
  }

  private detach(key: string, sink: EventSink): void {
    const sinks = this.streams.get(key);
    if (!sinks) return;
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
    if (sinks.length === 0) this.streams.delete(key);
  }

  private evict(sink: EventSink): void {
    try {
      sink.write(sseFrame('replaced', {}));
    } catch (error) {
      this.logger.warn(`Could not tell a stream it was replaced: ${messageOf(error)}`);
    }
    this.endQuietly(sink);
  }

  private endQuietly(sink: EventSink): void {
    try {
      sink.end();
    } catch (error) {
      this.logger.warn(`Could not end a stream: ${messageOf(error)}`);
    }
  }
}

function keyOf(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
