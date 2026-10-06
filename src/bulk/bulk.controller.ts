import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import { TagSchema } from '../records/records.dto.js';
import { BulkService, type BulkResult } from './bulk.service.js';

const IdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(200)
  .transform((ids) => [...new Set(ids)]);
const MoveSchema = z.object({ ids: IdsSchema, folderId: z.string().min(1) }).strict();
const TrashSchema = z.object({ ids: IdsSchema }).strict();
const RetagSchema = z
  .object({
    ids: IdsSchema,
    add: z.array(TagSchema).max(20).default([]),
    remove: z.array(TagSchema).max(20).default([]),
  })
  .strict()
  .refine((body) => body.add.length + body.remove.length > 0, {
    message: 'Add or remove at least one tag',
  });

@Controller('bulk/records')
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Post('move')
  @HttpCode(200)
  move(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(MoveSchema)) body: z.infer<typeof MoveSchema>,
  ): Promise<BulkResult> {
    return this.bulk.move(principal, body.ids, body.folderId);
  }

  @Post('trash')
  @HttpCode(200)
  trash(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(TrashSchema)) body: z.infer<typeof TrashSchema>,
  ): Promise<BulkResult> {
    return this.bulk.trashRecords(principal, body.ids);
  }

  @Post('tags')
  @HttpCode(200)
  retag(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(RetagSchema)) body: z.infer<typeof RetagSchema>,
  ): Promise<BulkResult> {
    return this.bulk.retag(principal, body.ids, body.add, body.remove);
  }
}
