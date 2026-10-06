import { z } from 'zod';

const FolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !/[/\\]/.test(name), 'Folder names cannot contain slashes');

export const CreateFolderSchema = z
  .object({ name: FolderNameSchema, parentId: z.string().min(1) })
  .strict();
export const RenameFolderSchema = z.object({ name: FolderNameSchema }).strict();
export const MoveFolderSchema = z.object({ parentId: z.string().min(1) }).strict();

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type RenameFolderInput = z.infer<typeof RenameFolderSchema>;
export type MoveFolderInput = z.infer<typeof MoveFolderSchema>;
