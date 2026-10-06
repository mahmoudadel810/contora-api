import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { parseBackfillArgs, SearchBackfill } from './search-backfill.js';
import { SearchBackfillModule } from './search-backfill.module.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const options = parseBackfillArgs(process.argv.slice(2));

const app = await NestFactory.createApplicationContext(SearchBackfillModule, {
  logger: ['log', 'warn', 'error'],
});
try {
  const summary = await app.get(SearchBackfill).run(options);
  if (summary.failed > 0) process.exitCode = 1;
} finally {
  await app.close();
}
