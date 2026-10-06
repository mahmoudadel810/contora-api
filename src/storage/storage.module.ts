import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Blob, BlobSchema } from './blob.schema.js';
import { BlobsRepository } from './blobs.repository.js';
import { BlobsService } from './blobs.service.js';
import { FILE_STORAGE } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Blob.name, schema: BlobSchema }]),
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        storage: diskStorage({ destination: join(config.STORAGE_DIR, 'tmp') }),
        limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 },
      }),
    }),
  ],
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new LocalFileStorage(config.STORAGE_DIR),
    },
    BlobsRepository,
    BlobsService,
  ],
  exports: [FILE_STORAGE, BlobsService, MulterModule],
})
export class StorageModule {}
