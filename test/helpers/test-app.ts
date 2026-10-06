import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DynamicModule, INestApplication, Type } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import request, { type Agent } from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';

export interface TestApp {
  app: INestApplication;
  http: () => Agent;
  stop: () => Promise<void>;
}

const AI_VARIABLES = [
  'AI_PROVIDER',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_USE_DEPLOYMENT_URLS',
  'AI_MODEL',
  'AI_MODEL_SUB',
];

export const TEST_JWT_SECRET = 'test-secret-value-that-is-at-least-32-chars-long';

export interface TestAppOptions {
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function createTestApp(
  extraImports: Array<Type | DynamicModule> = [],
  env: Record<string, string> = {},
  options: TestAppOptions = {},
): Promise<TestApp> {
  const mongo = await MongoMemoryServer.create();
  const storageDir = await mkdtemp(join(tmpdir(), 'contora-storage-'));

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongo.getUri('contora_test');
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.STORAGE_DIR = storageDir;
  process.env.MAX_UPLOAD_MB = '1';
  process.env.INVITATION_TTL_DAYS = '7';
  process.env.AUTH_RATE_LIMIT = '100000';
  process.env.TRUST_PROXY = '0';
  process.env.BLOB_REUSE_GRACE_SECONDS = '0';
  for (const name of [...AI_VARIABLES, ...Object.keys(process.env)]) {
    if (/^(AI_|AZURE_OPENAI_)/.test(name)) process.env[name] = '';
  }
  process.env.SEARCH_MAX_TIME_MS = '3000';
  process.env.SEARCH_RATE_LIMIT = '100000';
  process.env.SEARCH_EXPORT_RATE_LIMIT = '100000';
  Object.assign(process.env, env);

  const builder = Test.createTestingModule({
    imports: [AppModule, ...extraImports],
  });
  const moduleRef = await (options.configure ? options.configure(builder) : builder).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const connection = app.get<Connection>(getConnectionToken());
  await Promise.all(Object.values(connection.models).map((model) => model.init()));

  return {
    app,
    http: () => request(app.getHttpServer()),
    stop: async () => {
      await app.close();
      await mongo.stop();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
