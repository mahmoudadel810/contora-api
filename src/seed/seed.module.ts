import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { CommentsModule } from '../comments/comments.module.js';
import { ContentTypesModule } from '../content-types/content-types.module.js';
import { FoldersModule } from '../folders/folders.module.js';
import { MembersModule } from '../members/members.module.js';
import { MyRecordsModule } from '../my-records/my-records.module.js';
import { SavedSearchesModule } from '../saved-searches/saved-searches.module.js';
import { RecordsModule } from '../records/records.module.js';
import { RelationsModule } from '../relations/relations.module.js';
import { TrashModule } from '../trash/trash.module.js';
import { SeedService } from './seed.service.js';

@Module({
  imports: [
    AccessModule,
    CommentsModule,
    ContentTypesModule,
    FoldersModule,
    RecordsModule,
    MyRecordsModule,
    SavedSearchesModule,
    RelationsModule,
    TrashModule,
    MembersModule,
  ],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
