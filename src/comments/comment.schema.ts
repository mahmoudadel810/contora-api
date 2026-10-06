import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FORMER_USER } from './mention-tokens.js';

@Schema({ _id: false })
export class CommentMention {
  @Prop({ type: String, enum: ['user'], required: true }) type: 'user';
  @Prop({ type: Types.ObjectId, required: true }) id: Types.ObjectId;
}

export const CommentMentionSchema = SchemaFactory.createForClass(CommentMention);

@Schema({ collection: 'record_comments', timestamps: { createdAt: true, updatedAt: false } })
export class RecordComment {
  @Prop({ type: Types.ObjectId, required: true }) tenantId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) recordId: Types.ObjectId;
  @Prop({ required: true }) body: string;
  @Prop({ type: [CommentMentionSchema], default: [] }) mentions: CommentMention[];
  @Prop({ type: Types.ObjectId, required: true }) authorId: Types.ObjectId;
  @Prop({ required: true }) authorName: string;
  createdAt: Date;
}

export type RecordCommentDocument = HydratedDocument<RecordComment>;
export const RecordCommentSchema = SchemaFactory.createForClass(RecordComment);
RecordCommentSchema.index({ tenantId: 1, recordId: 1, createdAt: 1 });

export interface MentionRef {
  type: 'user';
  id: string;
  displayName: string;
  active: boolean;
}

export interface CommentView {
  id: string;
  body: string;
  mentions: MentionRef[];
  author: { id: string; displayName: string };
  createdAt: string;
}

export interface MentionedPerson {
  displayName: string;
  status: 'active' | 'suspended' | 'removed';
}

export function toCommentView(
  comment: RecordCommentDocument,
  people: ReadonlyMap<string, MentionedPerson> = new Map(),
): CommentView {
  return {
    id: comment._id.toHexString(),
    body: comment.body,
    mentions: (comment.mentions ?? []).map((mention) => {
      const id = mention.id.toHexString();
      const person = people.get(id);
      return {
        type: 'user' as const,
        id,
        displayName: person && person.status !== 'removed' ? person.displayName : FORMER_USER,
        active: person?.status === 'active',
      };
    }),
    author: { id: comment.authorId.toHexString(), displayName: comment.authorName },
    createdAt: comment.createdAt.toISOString(),
  };
}
