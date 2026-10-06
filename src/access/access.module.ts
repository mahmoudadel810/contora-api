import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Folder, FolderSchema } from '../folders/folder.schema.js';
import { RecordEntity, RecordSchema } from '../records/record.schema.js';
import { AccessGrant, AccessGrantSchema } from './access-grant.schema.js';
import {
  AccessFoldersReader,
  AccessGrantsRepository,
  AccessRecordsReader,
} from './access-grants.repository.js';
import { AccessController, MyAccessController } from './access.controller.js';
import { AccessService } from './access.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccessGrant.name, schema: AccessGrantSchema },
      { name: Folder.name, schema: FolderSchema },
      { name: RecordEntity.name, schema: RecordSchema },
    ]),
  ],
  controllers: [AccessController, MyAccessController],
  providers: [AccessGrantsRepository, AccessFoldersReader, AccessRecordsReader, AccessService],
  exports: [AccessService],
})
export class AccessModule {}
