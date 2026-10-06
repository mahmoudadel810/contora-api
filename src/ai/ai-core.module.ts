import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AiAvailability } from './ai-availability.js';
import { AiProvider, AzureAiProvider } from './ai-provider.js';
import { AI_SETTINGS, aiSettingsOf, type AiSettings } from './ai-settings.js';
import { AiDataModule } from './data/ai-data.module.js';

@Module({
  imports: [AiDataModule],
  providers: [
    {
      provide: AI_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AiSettings => aiSettingsOf(config),
    },
    {
      provide: AiProvider,
      inject: [AI_SETTINGS],
      useFactory: (settings: AiSettings): AiProvider => new AzureAiProvider(settings),
    },
    AiAvailability,
  ],
  exports: [AI_SETTINGS, AiProvider, AiAvailability, AiDataModule],
})
export class AiCoreModule {}
