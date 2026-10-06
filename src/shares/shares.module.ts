import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessModule } from '../access/access.module.js';
import { RecordsModule } from '../records/records.module.js';
import { PublicShareController } from './public-share.controller.js';
import { ShareAccessService } from './share-access.service.js';
import { ShareLink, ShareLinkSchema } from './share-link.schema.js';
import { ShareLinksController } from './share-links.controller.js';
import { ShareLinksRepository } from './share-links.repository.js';
import { ShareLinksService } from './share-links.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ShareLink.name, schema: ShareLinkSchema }]),
    RecordsModule,
    AccessModule,
  ],
  controllers: [ShareLinksController, PublicShareController],
  providers: [ShareLinksRepository, ShareLinksService, ShareAccessService],
  exports: [ShareLinksService],
})
export class SharesModule {}
