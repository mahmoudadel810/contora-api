import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import type { RecordView } from '../records/record.view.js';
import { TrashService, type PurgeResult, type TrashView } from './trash.service.js';

@Controller()
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  @Delete('records/:id')
  @HttpCode(204)
  trashRecord(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.trash.trashRecord(principal, id);
  }

  @Delete('folders/:id')
  @HttpCode(204)
  trashFolder(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.trash.trashFolder(principal, id);
  }

  @Get('trash')
  list(@CurrentUser() principal: Principal): Promise<TrashView> {
    return this.trash.list(principal);
  }

  @Post('trash/records/:id/restore')
  @HttpCode(200)
  restoreRecord(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RecordView> {
    return this.trash.restoreRecord(principal, id);
  }

  @Post('trash/folders/:id/restore')
  @HttpCode(204)
  restoreFolder(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.trash.restoreFolder(principal, id);
  }

  @Delete('trash/records/:id')
  purgeRecord(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<PurgeResult> {
    return this.trash.purgeRecord(principal, id);
  }

  @Delete('trash/folders/:id')
  purgeFolder(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<PurgeResult> {
    return this.trash.purgeFolder(principal, id);
  }

  @Delete('trash')
  empty(@CurrentUser() principal: Principal): Promise<PurgeResult> {
    return this.trash.empty(principal);
  }
}
