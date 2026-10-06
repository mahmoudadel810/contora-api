import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { AppError } from '../common/errors.js';
import { UsersRepository } from '../users/users.repository.js';

export const sessionRevoked = () =>
  new AppError(HttpStatus.UNAUTHORIZED, 'AI_SESSION_REVOKED', 'Your session has ended');

@Injectable()
export class PrincipalRefresher {
  constructor(private readonly users: UsersRepository) {}

  async refresh(principal: Principal, authenticatedAt: Date): Promise<Principal> {
    const user = await this.users.findById(principal.tenantId, principal.userId);
    const cutOff = user?.tokensValidAfter?.getTime();
    if (
      !user ||
      user.status !== 'active' ||
      (cutOff !== undefined && cutOff > authenticatedAt.getTime())
    ) {
      throw sessionRevoked();
    }
    return {
      userId: user._id.toHexString(),
      tenantId: user.tenantId.toHexString(),
      role: user.role,
      email: user.email,
      displayName: user.displayName,
    };
  }

  async isActive(principal: Principal): Promise<boolean> {
    const user = await this.users.findById(principal.tenantId, principal.userId);
    return user?.status === 'active';
  }
}
