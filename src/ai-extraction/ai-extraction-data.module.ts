import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiExtractionJob, AiExtractionJobSchema } from './ai-extraction-job.schema.js';
import { ExtractionJobsRepository } from './ai-extraction-jobs.repository.js';
import { AiExtractionDataService } from './ai-extraction-data.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AiExtractionJob.name, schema: AiExtractionJobSchema }]),
  ],
  providers: [ExtractionJobsRepository, AiExtractionDataService],
  exports: [ExtractionJobsRepository, AiExtractionDataService],
})
export class AiExtractionDataModule {}
