import { createAzure } from '@ai-sdk/azure';
import { HttpStatus, Logger } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { AppError } from '../common/errors.js';
import type { AiSettings } from './ai-settings.js';

export type ModelTier = 'main' | 'sub';

export interface AiProviderStatus {
  enabled: boolean;
  reason: null | 'NOT_CONFIGURED';
  model: string | null;
}

export const aiDisabled = () =>
  new AppError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'AI_DISABLED',
    'The assistant is not configured for this workspace',
  );

export abstract class AiProvider {
  abstract isEnabled(): boolean;
  abstract status(): AiProviderStatus;
  abstract model(tier: ModelTier): LanguageModel;
}

export class AzureAiProvider extends AiProvider {
  private readonly models: Record<ModelTier, LanguageModel> | null;

  constructor(private readonly settings: AiSettings) {
    super();
    const azure = settings.azure;
    if (!azure) {
      if (settings.partial) {
        new Logger('Ai').warn(
          `The assistant is disabled: missing or invalid ${settings.missing.join(', ')}`,
        );
      }
      this.models = null;
      return;
    }
    const provider = createAzure({
      apiKey: azure.apiKey,
      ...(azure.baseURL ? { baseURL: azure.baseURL } : { resourceName: azure.resourceName ?? '' }),
      apiVersion: azure.apiVersion,
      useDeploymentBasedUrls: azure.useDeploymentBasedUrls,
    });
    this.models = { main: provider.chat(azure.model), sub: provider.chat(azure.modelSub) };
  }

  isEnabled(): boolean {
    return this.models !== null;
  }

  status(): AiProviderStatus {
    return this.settings.azure
      ? { enabled: true, reason: null, model: this.settings.azure.model }
      : { enabled: false, reason: 'NOT_CONFIGURED', model: null };
  }

  model(tier: ModelTier): LanguageModel {
    if (!this.models) throw aiDisabled();
    return this.models[tier];
  }
}
