import { existsSync } from 'node:fs';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

if (process.env.NODE_ENV !== 'test' && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const app = await NestFactory.create(AppModule, {
  logger: new ConsoleLogger({ json: process.env.NODE_ENV === 'production' }),
});
configureApp(app);
app.enableShutdownHooks();
const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.PORT);
