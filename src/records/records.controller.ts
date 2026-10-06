import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../auth/principal.js';
import type { Page } from '../common/pagination.js';
import { parseWith, zodPipe } from '../common/zod.pipe.js';
import type { RecordDetailView, RecordView, VersionView } from './record.view.js';
import {
  CreateRecordSchema,
  DownloadQuerySchema,
  ListRecordsQuerySchema,
  metadataFiltersOf,
  MoveRecordSchema,
  NewVersionSchema,
  RenameRecordSchema,
  RestoreVersionSchema,
  SetTagsSchema,
  type CreateRecordInput,
  type DownloadQuery,
  type ListRecordsQuery,
  type MoveRecordInput,
  type NewVersionInput,
  type RenameRecordInput,
  type RestoreVersionInput,
  type SetTagsInput,
} from './records.dto.js';
import { stream } from './file-response.js';
import { RecordsService } from './records.service.js';
import { discardTemp, ingestible } from './uploads.js';
import { SearchThrottle, SearchThrottlerGuard } from './search-throttler.guard.js';

const VersionNumberPipe = zodPipe(z.coerce.number().int().positive());

@Controller('records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  @UseGuards(SearchThrottlerGuard)
  @SearchThrottle('list')
  list(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(ListRecordsQuerySchema)) query: ListRecordsQuery,
  ): Promise<Page<RecordView>> {
    return this.records.list(principal, query, metadataFiltersOf(query));
  }

  @Get('export')
  @UseGuards(SearchThrottlerGuard)
  @SearchThrottle('export')
  async exportCsv(
    @CurrentUser() principal: Principal,
    @Query(zodPipe(ListRecordsQuerySchema)) query: ListRecordsQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const result = await this.records.exportCsv(principal, query, metadataFiltersOf(query));
    const day = new Date().toISOString().slice(0, 10);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="records-${day}.csv"`);
    response.setHeader('X-Export-Count', String(result.count));
    response.setHeader('X-Export-Truncated', String(result.truncated));
    return result.csv;
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async create(
    @CurrentUser() principal: Principal,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<RecordView> {
    try {
      const input: CreateRecordInput = parseWith(CreateRecordSchema, body);
      return await this.records.create(principal, input, ingestible(file));
    } finally {
      await discardTemp(file);
    }
  }

  @Get(':id')
  get(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RecordDetailView> {
    return this.records.get(principal, id);
  }

  @Patch(':id')
  rename(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(RenameRecordSchema)) body: RenameRecordInput,
  ): Promise<RecordView> {
    return this.records.rename(principal, id, body);
  }

  @Put(':id/tags')
  setTags(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(SetTagsSchema)) body: SetTagsInput,
  ): Promise<RecordView> {
    return this.records.setTags(principal, id, body);
  }

  @Post(':id/move')
  @HttpCode(200)
  move(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(MoveRecordSchema)) body: MoveRecordInput,
  ): Promise<RecordView> {
    return this.records.move(principal, id, body);
  }

  @Get(':id/content')
  async currentContent(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Query(zodPipe(DownloadQuerySchema)) query: DownloadQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return stream(
      await this.records.openFile(principal, id, 'current'),
      response,
      query.disposition,
    );
  }

  @Get(':id/versions')
  versions(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<VersionView[]> {
    return this.records.listVersions(principal, id);
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file'))
  async addVersion(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<VersionView> {
    try {
      const input: NewVersionInput = parseWith(NewVersionSchema, body ?? {});
      return await this.records.addVersion(principal, id, input, ingestible(file));
    } finally {
      await discardTemp(file);
    }
  }

  @Get(':id/versions/:number')
  version(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Param('number', VersionNumberPipe) versionNumber: number,
  ): Promise<VersionView> {
    return this.records.getVersion(principal, id, versionNumber);
  }

  @Get(':id/versions/:number/content')
  async versionContent(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Param('number', VersionNumberPipe) versionNumber: number,
    @Query(zodPipe(DownloadQuerySchema)) query: DownloadQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    return stream(
      await this.records.openFile(principal, id, versionNumber),
      response,
      query.disposition,
    );
  }

  @Post(':id/versions/:number/restore')
  restore(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Param('number', VersionNumberPipe) versionNumber: number,
    @Body(zodPipe(RestoreVersionSchema)) body: RestoreVersionInput,
  ): Promise<VersionView> {
    return this.records.restoreVersion(principal, id, versionNumber, body);
  }

  @Post(':id/checkout')
  @HttpCode(200)
  checkOut(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RecordView> {
    return this.records.checkOut(principal, id);
  }

  @Post(':id/checkin')
  @HttpCode(200)
  checkIn(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RecordView> {
    return this.records.checkIn(principal, id);
  }

  @Post(':id/force-release')
  @HttpCode(200)
  forceRelease(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<RecordView> {
    return this.records.forceRelease(principal, id);
  }
}

@Controller('tags')
export class TagsController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  list(@CurrentUser() principal: Principal): Promise<Array<{ tag: string; count: number }>> {
    return this.records.tagCloud(principal);
  }
}
