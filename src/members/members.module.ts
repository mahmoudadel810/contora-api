import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiDataModule } from '../ai/data/ai-data.module.js';
import { AiExtractionDataModule } from '../ai-extraction/ai-extraction-data.module.js';
import { MyRecordsModule } from '../my-records/my-records.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { SavedSearchesModule } from '../saved-searches/saved-searches.module.js';
import { SharesModule } from '../shares/shares.module.js';
import { Invitation, InvitationSchema } from './invitation.schema.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';
import { MembersController } from './members.controller.js';
import { PeopleController } from './people.controller.js';
import { MembersService } from './members.service.js';

@Module({
  imports: [
    AccessModule,
    MongooseModule.forFeature([{ name: Invitation.name, schema: InvitationSchema }]),
    MyRecordsModule,
    SavedSearchesModule,
    NotificationsModule,
    SharesModule,
    AiExtractionDataModule,
    AiDataModule,
  ],
  controllers: [MembersController, PeopleController],
  providers: [MembersService, InvitationsService, InvitationsRepository],
  exports: [InvitationsRepository, MembersService, InvitationsService],
})
export class MembersModule {}
