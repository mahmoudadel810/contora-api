import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SavedSearch, SavedSearchSchema } from './saved-search.schema.js';
import { SavedSearchesController } from './saved-searches.controller.js';
import { SavedSearchesService } from './saved-searches.service.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: SavedSearch.name, schema: SavedSearchSchema }])],
  controllers: [SavedSearchesController],
  providers: [SavedSearchesService],
  exports: [SavedSearchesService],
})
export class SavedSearchesModule {}
