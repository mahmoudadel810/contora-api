import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { Public } from '../auth/public.decorator.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

export const READINESS_TIMEOUT_MS = 2_000;

type Check = 'ok' | 'error';

export interface Readiness {
  status: Check;
  mongo: Check;
  storage: Check;
}

async function probe(check: () => Promise<unknown>): Promise<Check> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), READINESS_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  check(): { status: 'ok'; time: string } {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    const [mongo, storage] = await Promise.all([
      probe(() => this.pingMongo()),
      probe(() => access(resolve(this.config.STORAGE_DIR), constants.W_OK)),
    ]);
    const status: Check = mongo === 'ok' && storage === 'ok' ? 'ok' : 'error';
    res.status(status === 'ok' ? 200 : 503);
    return { status, mongo, storage };
  }

  async pingMongo(): Promise<void> {
    const db = this.connection.db;
    if (this.connection.readyState !== 1 || !db) throw new Error('not connected');
    await db.admin().ping();
  }
}
