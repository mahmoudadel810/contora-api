import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { IndexSync } from './index-sync.js';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.MONGODB_URI,
        autoIndex: config.NODE_ENV !== 'production',
      }),
    }),
  ],
  providers: [IndexSync],
})
export class DatabaseModule {}
