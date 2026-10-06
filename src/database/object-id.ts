import { Types } from 'mongoose';

export function isObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Types.ObjectId.isValid(value) &&
    new Types.ObjectId(value).toHexString() === value
  );
}

export function toObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}

export function idOf(entity: { _id: Types.ObjectId }): string {
  return entity._id.toHexString();
}
