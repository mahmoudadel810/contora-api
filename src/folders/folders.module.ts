import { AccessModule } from '../access/access.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Folder, FolderSchema } from './folder.schema.js';
import { FoldersController } from './folders.controller.js';
import { FoldersRepository } from './folders.repository.js';
import { FoldersService } from './folders.service.js';

@Module({
  imports: [MongooseModule.forFeature([{ name: Folder.name, schema: FolderSchema }]), AccessModule],
  controllers: [FoldersController],
  providers: [FoldersRepository, FoldersService],
  exports: [FoldersService, FoldersRepository],
})
export class FoldersModule {}
