import { Injectable } from '@nestjs/common';
import {
  AiActionsRepository,
  AiMessagesRepository,
  AiSessionsRepository,
} from './ai-data.repositories.js';

@Injectable()
export class AiDataService {
  constructor(
    private readonly sessions: AiSessionsRepository,
    private readonly messages: AiMessagesRepository,
    private readonly actions: AiActionsRepository,
  ) {}

  async clearForUser(tenantId: string, userId: string): Promise<void> {
    const owner = { tenantId, userId };
    await this.actions.deleteMany(owner, {});
    await this.messages.deleteMany(owner, {});
    await this.sessions.deleteMany(owner, {});
  }
}
