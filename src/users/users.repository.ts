import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantRepository } from '../database/tenant.repository.js';
import { User, type UserDocument } from './user.schema.js';

@Injectable()
export class UsersRepository extends TenantRepository<User> {
  constructor(@InjectModel(User.name) model: Model<User>) {
    super(model);
  }

  findByEmailAcrossTenants(email: string): Promise<UserDocument | null> {
    return this.model.findOne({ email: email.trim().toLowerCase() }).exec();
  }

  async emailTaken(email: string): Promise<boolean> {
    return (await this.model.exists({ email: email.trim().toLowerCase() })) !== null;
  }
}
