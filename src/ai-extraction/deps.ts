import type { AiUsageKind } from '../ai/data/ai-usage-daily.schema.js';

export { AiCoreModule } from '../ai/ai-core.module.js';
export {
  AiProvider,
  aiDisabled,
  type AiProviderStatus,
  type ModelTier,
} from '../ai/ai-provider.js';
export { AiAvailability } from '../ai/ai-availability.js';
export { AiUsageService, usageDayOf, secondsUntilNextDay } from '../ai/data/ai-usage.service.js';
export { AiUsageRepository } from '../ai/data/ai-data.repositories.js';
export { type AiUsageKind } from '../ai/data/ai-usage-daily.schema.js';
export { AiOwnedRepository, type Owner, type UserOwned } from '../ai/data/ai-owned.repository.js';
export { redactProviderError, type RedactedProviderError } from '../ai/redact-provider-error.js';
export { AI_OUTPUT_TOKENS_CEILING } from '../config/env.js';

export const EXTRACTION_USAGE_KIND: AiUsageKind = 'extraction';

export {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
} from 'ai';

export { foldDigits, normalizeArabic, stripInvisibles } from '../common/arabic-normalize.js';

export {
  FIELD_TYPES,
  canonicalInstant,
  effectiveBounds,
  valueSchemaFor,
  type FieldDefinition,
  type FieldType,
  type FieldValue,
} from '../content-types/field-types.js';
