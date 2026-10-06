import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Principal } from './principal.js';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = req.principal as Principal | undefined;
    return principal ? `user:${principal.tenantId}:${principal.userId}` : super.getTracker(req);
  }
}
