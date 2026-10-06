import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '../config/config.module.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Tenant, TenantSchema } from '../tenants/tenant.schema.js';
import { RecordEntity, RecordSchema } from './record.schema.js';
import { RecordsRepository } from './records.repository.js';
import { SearchBackfill } from './search-backfill.js';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ uri: config.MONGODB_URI, autoIndex: false }),
    }),
    MongooseModule.forFeature([
      { name: RecordEntity.name, schema: RecordSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
  ],
  providers: [RecordsRepository, SearchBackfill],
})
export class SearchBackfillModule {}
