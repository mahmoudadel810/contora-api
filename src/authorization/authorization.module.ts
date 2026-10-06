import { Global, Module } from '@nestjs/common';
import { PolicyService } from './policy.service.js';

@Global()
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class AuthorizationModule {}
