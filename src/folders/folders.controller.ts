import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { zodPipe } from '../common/zod.pipe.js';
import type { FolderDetailView, FolderView } from './folder.schema.js';
import {
  CreateFolderSchema,
  MoveFolderSchema,
  RenameFolderSchema,
  type CreateFolderInput,
  type MoveFolderInput,
  type RenameFolderInput,
} from './folders.dto.js';
import { FoldersService } from './folders.service.js';

@Controller('folders')
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get('root')
  root(@CurrentUser() principal: Principal): Promise<FolderDetailView> {
    return this.folders.root(principal);
  }

  @Get('tree')
  tree(@CurrentUser() principal: Principal): Promise<FolderView[]> {
    return this.folders.tree(principal);
  }

  @Get(':id')
  get(@CurrentUser() principal: Principal, @Param('id') id: string): Promise<FolderDetailView> {
    return this.folders.get(principal, id);
  }

  @Post()
  create(
    @CurrentUser() principal: Principal,
    @Body(zodPipe(CreateFolderSchema)) body: CreateFolderInput,
  ): Promise<FolderView> {
    return this.folders.create(principal, body);
  }

  @Patch(':id')
  rename(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(RenameFolderSchema)) body: RenameFolderInput,
  ): Promise<FolderView> {
    return this.folders.rename(principal, id, body);
  }

  @Post(':id/move')
  @HttpCode(200)
  move(
    @CurrentUser() principal: Principal,
    @Param('id') id: string,
    @Body(zodPipe(MoveFolderSchema)) body: MoveFolderInput,
  ): Promise<FolderView> {
    return this.folders.move(principal, id, body);
  }
}
