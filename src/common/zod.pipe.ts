import { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { errors } from './errors.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [...issue.path, key].map(String).join('.'),
        message: `Unrecognized key "${key}"`,
      }));
    }
    return [{ path: issue.path.map(String).join('.'), message: issue.message }];
  });
}

export function parseWith<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw errors.validation(issuesOf(result.error));
  }
  return result.data;
}

export interface SchemaPipe<T extends z.ZodType> extends PipeTransform<unknown, z.output<T>> {
  readonly schema: T;
}

export function zodPipe<T extends z.ZodType>(schema: T): SchemaPipe<T> {
  return {
    schema,
    transform(value: unknown): z.output<T> {
      return parseWith(schema, value);
    },
  };
}
