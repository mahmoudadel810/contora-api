import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { UserThrottlerGuard } from '../auth/user-throttler.guard.js';
import { zodPipe } from '../common/zod.pipe.js';
import { CommentsService, type MentionCandidate } from './comments.service.js';

const MentionableQuerySchema = z.object({ q: z.string().max(64).default('') }).strict();

@Controller('records/:id/mentionable-users')
export class MentionsController {
  constructor(private readonly comments: CommentsService) {}

  @UseGuards(UserThrottlerGuard)
  @Throttle({ auth: { limit: 120, ttl: 60_000 } })
  @Get()
  list(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Query(zodPipe(MentionableQuerySchema)) query: z.infer<typeof MentionableQuerySchema>,
  ): Promise<{ items: MentionCandidate[] }> {
    return this.comments.mentionCandidates(principal, id, query.q);
  }
}
