import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tenant, TenantSchema } from '../tenants/tenant.schema.js';
import { User, UserSchema } from './user.schema.js';
import { UsersRepository } from './users.repository.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Tenant.name, schema: TenantSchema },
    ]),
  ],
  providers: [UsersRepository],
  exports: [UsersRepository, MongooseModule],
})
export class UsersModule {}
