import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiReferenceController } from './api-reference.controller.js';
import { ApiReferenceService } from './api-reference.service.js';

@Module({
  imports: [DiscoveryModule],
  controllers: [ApiReferenceController],
  providers: [ApiReferenceService],
})
export class ApiReferenceModule {}
