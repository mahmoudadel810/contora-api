import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { RecordsModule } from '../records/records.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [RecordsModule, FoldersModule, ContentTypesModule, AccessModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
