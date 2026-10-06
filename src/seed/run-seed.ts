import { existsSync } from 'node:fs';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { SeedModule } from './seed.module.js';
import { DEMO_PASSWORD } from './demo-data.js';
import { SeedService } from './seed.service.js';

if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env.NODE_ENV === 'production') {
  Logger.error('Refusing to seed demo data when NODE_ENV=production', 'Seed');
  process.exit(1);
}

@Module({ imports: [AppModule, SeedModule] })
class SeedAppModule {}

const app = await NestFactory.createApplicationContext(SeedAppModule, {
  logger: ['log', 'warn', 'error'],
});
try {
  const summary = await app.get(SeedService).run();
  Logger.log(
    summary.created
      ? `Created "${summary.tenant}" (${summary.added.length} items)`
      : summary.added.length > 0
        ? `Added ${summary.added.length} missing items to "${summary.tenant}"`
        : `"${summary.tenant}" already complete`,
    'Seed',
  );
  Logger.log(`Sign in as ${summary.accounts.join(' or ')} with password ${DEMO_PASSWORD}`, 'Seed');
} finally {
  await app.close();
}
