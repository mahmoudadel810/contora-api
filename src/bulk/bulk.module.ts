import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module.js';
import { TrashModule } from '../trash/trash.module.js';
import { BulkController } from './bulk.controller.js';
import { BulkService } from './bulk.service.js';

@Module({
  imports: [RecordsModule, TrashModule],
  controllers: [BulkController],
  providers: [BulkService],
  exports: [BulkService],
})
export class BulkModule {}
