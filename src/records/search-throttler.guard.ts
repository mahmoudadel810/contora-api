import { Inject, Injectable, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { UserThrottlerGuard } from '../auth/user-throttler.guard.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { META_PREFIX } from './records.dto.js';

const SEARCH_THROTTLE = 'searchThrottle';
const WINDOW_MS = 60_000;

export type SearchThrottleKind = 'list' | 'export';

export const SearchThrottle = (kind: SearchThrottleKind) => SetMetadata(SEARCH_THROTTLE, kind);

function hasText(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasText);
  return typeof value === 'string' && value.trim() !== '';
}

export function isTextSearch(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  return Object.entries(query).some(
    ([key, value]) => (key === 'q' || key.startsWith(META_PREFIX)) && hasText(value),
  );
}

@Injectable()
export class SearchThrottlerGuard extends UserThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super(options, storageService, reflector);
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    return Promise.resolve(!isTextSearch(req.query));
  }

  protected override handleRequest(request: ThrottlerRequest): Promise<boolean> {
    const kind = this.reflector.get<SearchThrottleKind | undefined>(
      SEARCH_THROTTLE,
      request.context.getHandler(),
    );
    const limit =
      kind === 'export' ? this.config.SEARCH_EXPORT_RATE_LIMIT : this.config.SEARCH_RATE_LIMIT;
    return super.handleRequest({
      ...request,
      limit,
      ttl: WINDOW_MS,
      blockDuration: WINDOW_MS,
    });
  }
}
