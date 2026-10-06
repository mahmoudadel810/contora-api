import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { RecordEntity, RecordSchema } from './record.schema.js';
import { RecordVersion, RecordVersionSchema } from './record-version.schema.js';
import { RecordActivityController } from './record-activity.controller.js';
import { RecordsController, TagsController } from './records.controller.js';
import { RecordState } from './record-state.js';
import { RecordsRepository, VersionsRepository } from './records.repository.js';
import { RecordsService } from './records.service.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([
      { name: RecordEntity.name, schema: RecordSchema },
      { name: RecordVersion.name, schema: RecordVersionSchema },
    ]),
    ContentTypesModule,
    FoldersModule,
  ],
  controllers: [RecordsController, TagsController, RecordActivityController],
  providers: [RecordsRepository, VersionsRepository, RecordState, RecordsService],
  exports: [RecordsService, RecordState, RecordsRepository, VersionsRepository],
})
export class RecordsModule {}
