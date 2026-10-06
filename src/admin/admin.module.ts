import { Module } from '@nestjs/common';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { MembersModule } from '../members/members.module.js';
import { RecordsModule } from '../records/records.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [RecordsModule, FoldersModule, ContentTypesModule, MembersModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
