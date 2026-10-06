import { Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import type { RecordView } from '../records/record.view.js';
import { MyRecordsService, type RecentRecordView } from './my-records.service.js';

@Controller('records/:id')
export class RecordFavoriteController {
  constructor(private readonly myRecords: MyRecordsService) {}

  @Get('favorite')
  async favorite(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ favorite: boolean }> {
    return { favorite: await this.myRecords.isFavorite(principal, id) };
  }

  @Put('favorite')
  @HttpCode(204)
  add(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.myRecords.addFavorite(principal, id);
  }

  @Delete('favorite')
  @HttpCode(204)
  remove(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.myRecords.removeFavorite(principal, id);
  }

  @Post('views')
  @HttpCode(204)
  viewed(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.myRecords.recordView(principal, id);
  }
}

@Controller('me')
export class MyRecordsController {
  constructor(private readonly myRecords: MyRecordsService) {}

  @Get('favorites')
  favorites(@CurrentUser() principal: Principal): Promise<RecordView[]> {
    return this.myRecords.listFavorites(principal);
  }

  @Get('recent')
  recent(@CurrentUser() principal: Principal): Promise<RecentRecordView[]> {
    return this.myRecords.listRecent(principal);
  }
}
