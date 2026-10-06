import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { Actor } from '../auth/principal.js';

interface RecordRef {
  id: string;
  name: string;
}

export type DomainEvent =
  | {
      type: 'comment.added';
      tenantId: string;
      actor: Actor;
      record: RecordRef & { createdBy: string };
      excerpt: string;
      commentId: string;
      mentionIds: string[];
      snippet: string;
    }
  | {
      type: 'version.created';
      tenantId: string;
      actor: Actor;
      record: RecordRef;
      versionNumber: number;
    }
  | {
      type: 'checkout.forceReleased';
      tenantId: string;
      actor: Actor;
      record: RecordRef;
      holderId: string;
    }
  | { type: 'member.roleChanged'; tenantId: string; actor: Actor; userId: string; role: string };

type Handler = (event: DomainEvent) => Promise<void>;

@Injectable()
export class DomainEvents {
  private readonly logger = new Logger('DomainEvents');
  private readonly handlers: Handler[] = [];

  subscribe(handler: Handler): void {
    this.handlers.push(handler);
  }

  async emit(event: DomainEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(
          `Handler failed for ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

@Global()
@Module({ providers: [DomainEvents], exports: [DomainEvents] })
export class EventsModule {}
