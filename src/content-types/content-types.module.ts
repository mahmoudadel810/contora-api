import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ContentType, ContentTypeSchema } from './content-type.schema.js';
import { ContentTypesController } from './content-types.controller.js';
import { ContentTypesRepository } from './content-types.repository.js';
import { ContentTypesService } from './content-types.service.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: ContentType.name, schema: ContentTypeSchema }])],
  controllers: [ContentTypesController],
  providers: [ContentTypesRepository, ContentTypesService],
  exports: [ContentTypesService, ContentTypesRepository],
})
export class ContentTypesModule {}
