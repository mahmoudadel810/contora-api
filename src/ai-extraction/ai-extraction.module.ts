import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessModule } from '../access/access.module.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { RecordsModule } from '../records/records.module.js';
import { Blob, BlobSchema } from '../storage/blob.schema.js';
import { AiExtractionController } from './ai-extraction.controller.js';
import { AiExtractionDataModule } from './ai-extraction-data.module.js';
import { AiExtractionHousekeeping } from './ai-extraction.housekeeping.js';
import { AiExtractionRunner } from './ai-extraction.runner.js';
import { AiExtractionService } from './ai-extraction.service.js';
import { AiCoreModule } from './deps.js';
import { ExtractionBlobsReader } from './extraction-readers.js';
import { EXTRACTION_SETTINGS, extractionSettingsOf } from './extraction-settings.js';
import { ExtractionUploadGuard } from './extraction-upload.js';
import { ExtractionTextSource, PlainTextSource } from './text-source.js';

@Module({
  imports: [
    AiExtractionDataModule,
    AiCoreModule,
    RecordsModule,
    ContentTypesModule,
    AccessModule,
    MongooseModule.forFeature([{ name: Blob.name, schema: BlobSchema }]),
  ],
  controllers: [AiExtractionController],
  providers: [
    {
      provide: EXTRACTION_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => extractionSettingsOf(config),
    },
    { provide: ExtractionTextSource, useClass: PlainTextSource },
    ExtractionBlobsReader,
    ExtractionUploadGuard,
    AiExtractionRunner,
    AiExtractionService,
    AiExtractionHousekeeping,
  ],
  exports: [AiExtractionService, AiExtractionRunner, AiExtractionHousekeeping],
})
export class AiExtractionModule {}
