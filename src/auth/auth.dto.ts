import { z } from 'zod';

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Invalid email address'));
export const PasswordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128);
export const DisplayNameSchema = z.string().trim().min(1).max(80);

export const SignUpSchema = z
  .object({
    tenantName: z.string().trim().min(2).max(80),
    displayName: DisplayNameSchema,
    email: EmailSchema,
    password: PasswordSchema,
  })
  .strict();

export const SignInSchema = z
  .object({ email: EmailSchema, password: z.string().min(1).max(128) })
  .strict();

export const UpdateProfileSchema = z.object({ displayName: DisplayNameSchema }).strict();

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: PasswordSchema,
  })
  .strict();

export type SignUpInput = z.infer<typeof SignUpSchema>;
export type SignInInput = z.infer<typeof SignInSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
