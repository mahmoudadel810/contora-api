import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { RecordsModule } from '../records/records.module.js';
import { RecordRelation, RecordRelationSchema } from './relation.schema.js';
import { RelationsController } from './relations.controller.js';
import { RelationsRepository } from './relations.repository.js';
import { RelationsService } from './relations.service.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([{ name: RecordRelation.name, schema: RecordRelationSchema }]),
    RecordsModule,
    FoldersModule,
    ContentTypesModule,
  ],
  controllers: [RelationsController],
  providers: [RelationsRepository, RelationsService],
  exports: [RelationsService],
})
export class RelationsModule {}
