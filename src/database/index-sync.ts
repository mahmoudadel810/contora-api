import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

interface IndexedModel {
  modelName: string;
  init(): Promise<unknown>;
  createIndexes(): Promise<unknown>;
}

export async function createAllIndexes(models: IndexedModel[]): Promise<number> {
  for (const model of models) {
    try {
      await model.init();
      await model.createIndexes();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not create the indexes of ${model.modelName}: ${reason}`, {
        cause: error,
      });
    }
  }
  return models.length;
}

@Injectable()
export class IndexSync implements OnApplicationBootstrap {
  private readonly logger = new Logger('Database');

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.NODE_ENV !== 'production') return;
    const count = await createAllIndexes(Object.values(this.connection.models));
    this.logger.log(`Indexes are in place for ${count} models`);
  }
}
