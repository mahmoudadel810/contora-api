import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { ROLES, type Role } from './role.js';

export const USER_STATUSES = ['active', 'suspended', 'removed'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  tenantId: Types.ObjectId;
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;
  @Prop({ required: true }) passwordHash: string;
  @Prop({ required: true, trim: true }) displayName: string;
  @Prop({ type: String, enum: ROLES, required: true }) role: Role;
  @Prop({ type: String, enum: USER_STATUSES, default: 'active' })
  status: UserStatus;
  @Prop({ type: Date, default: null }) lastSignInAt: Date | null;
  @Prop({ type: Date, default: null }) tokensValidAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastSignInAt?: string | null;
}

export interface UserViewOptions {
  withSignIn: boolean;
}

export function toUserView(user: UserDocument, options: UserViewOptions): UserView {
  return {
    id: user._id.toHexString(),
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    ...(options.withSignIn ? { lastSignInAt: user.lastSignInAt?.toISOString() ?? null } : {}),
  };
}
