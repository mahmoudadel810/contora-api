import { Injectable } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { AiProvider, aiDisabled } from './ai-provider.js';

@Injectable()
export class AiAvailability {
  constructor(private readonly provider: AiProvider) {}

  assertAiAvailable(principal: Principal): void {
    if (!this.provider.isEnabled()) throw aiDisabled();
    void principal;
  }
}
