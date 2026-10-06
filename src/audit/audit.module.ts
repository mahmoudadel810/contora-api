import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditEntry, AuditEntrySchema } from './audit-entry.schema.js';
import { AuditController } from './audit.controller.js';
import { ActivityReportService } from './activity-report.service.js';
import { AuditEntriesRepository } from './audit-entries.repository.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: AuditEntry.name, schema: AuditEntrySchema }])],
  controllers: [AuditController],
  providers: [AuditEntriesRepository, AuditService, ActivityReportService],
  exports: [AuditService, ActivityReportService],
})
export class AuditModule {}
