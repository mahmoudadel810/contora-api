import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'tenants', timestamps: true })
export class Tenant {
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ required: true, unique: true, lowercase: true }) slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TenantDocument = HydratedDocument<Tenant>;
export const TenantSchema = SchemaFactory.createForClass(Tenant);

export interface TenantView {
  id: string;
  name: string;
  slug: string;
}

export function toTenantView(tenant: TenantDocument): TenantView {
  return { id: tenant._id.toHexString(), name: tenant.name, slug: tenant.slug };
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'tenant';
}
