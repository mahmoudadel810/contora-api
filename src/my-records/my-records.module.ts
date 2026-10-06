import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecordsModule } from '../records/records.module.js';
import {
  RecordFavorite,
  RecordFavoriteSchema,
  RecordViewEntry,
  RecordViewEntrySchema,
} from './favorite.schema.js';
import { MyRecordsController, RecordFavoriteController } from './my-records.controller.js';
import { MyRecordsService } from './my-records.service.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([
      { name: RecordFavorite.name, schema: RecordFavoriteSchema },
      { name: RecordViewEntry.name, schema: RecordViewEntrySchema },
    ]),
    RecordsModule,
  ],
  controllers: [RecordFavoriteController, MyRecordsController],
  providers: [MyRecordsService],
  exports: [MyRecordsService],
})
export class MyRecordsModule {}
