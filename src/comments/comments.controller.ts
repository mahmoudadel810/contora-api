import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { UserThrottlerGuard } from '../auth/user-throttler.guard.js';
import { zodPipe } from '../common/zod.pipe.js';
import type { CommentView } from './comment.schema.js';
import { CommentsService, MAX_COMMENT_BODY } from './comments.service.js';

const CommentBodySchema = z
  .object({ body: z.string().trim().min(1).max(MAX_COMMENT_BODY) })
  .strict();

@Controller('records/:id/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  list(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<CommentView[]> {
    return this.comments.list(principal, id);
  }

  @UseGuards(UserThrottlerGuard)
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  @Post()
  add(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(CommentBodySchema)) body: z.infer<typeof CommentBodySchema>,
  ): Promise<CommentView> {
    return this.comments.add(principal, id, body.body);
  }

  @Delete(':commentId')
  @HttpCode(204)
  remove(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    return this.comments.remove(principal, id, commentId);
  }
}
