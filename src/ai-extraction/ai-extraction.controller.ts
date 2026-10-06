import { rm } from 'node:fs/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { errors } from '../common/errors.js';
import { parseWith, zodPipe } from '../common/zod.pipe.js';
import type { RecordView } from '../records/record.view.js';
import {
  ConfirmExtractionSchema,
  StartExtractionSchema,
  type ConfirmExtractionInput,
} from './ai-extraction.dto.js';
import { AiExtractionService } from './ai-extraction.service.js';
import {
  extractionUploadLimits,
  ExtractionUploadGuard,
  FileTooLargeFilter,
} from './extraction-upload.js';
import type { ExtractionJobView } from './extraction-view.js';

async function discardTemp(file: Express.Multer.File | undefined): Promise<void> {
  if (file?.path) await rm(file.path, { force: true });
}

@Controller('ai/extractions')
export class AiExtractionController {
  constructor(private readonly extractions: AiExtractionService) {}

  @Post()
  @HttpCode(202)
  @UseGuards(ExtractionUploadGuard)
  @UseFilters(FileTooLargeFilter)
  @UseInterceptors(FileInterceptor('file', { limits: extractionUploadLimits }))
  async start(
    @CurrentUser() principal: Principal,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ): Promise<ExtractionJobView> {
    try {
      const input = parseWith(StartExtractionSchema, body ?? {});
      if (!file) throw errors.validation([{ path: 'file', message: 'A file is required' }]);
      return await this.extractions.start(principal, input, {
        path: file.path,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    } finally {
      await discardTemp(file);
    }
  }

  @Get(':id')
  get(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<ExtractionJobView> {
    return this.extractions.get(principal, id);
  }

  @Post(':id/confirm')
  @HttpCode(201)
  confirm(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(ConfirmExtractionSchema)) body: ConfirmExtractionInput,
  ): Promise<RecordView> {
    return this.extractions.confirm(principal, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  discard(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<void> {
    return this.extractions.discard(principal, id);
  }
}
