import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { errors } from '../common/errors.js';
import { UsersRepository } from '../users/users.repository.js';
import type { RequestWithPrincipal } from './principal.js';
import { IS_PUBLIC } from './public.decorator.js';
import { issuedAtMs, TokensService } from './tokens.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly users: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw errors.unauthorized();

    const payload = this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    const user = await this.users.findById(payload.tid, payload.sub);
    const cutOff = user?.tokensValidAfter?.getTime();
    if (
      !user ||
      user.status !== 'active' ||
      (cutOff !== undefined && issuedAtMs(payload) < cutOff)
    ) {
      throw errors.unauthorized('Invalid or expired access token');
    }
    request.principal = {
      userId: user._id.toHexString(),
      tenantId: user.tenantId.toHexString(),
      role: user.role,
      email: user.email,
      displayName: user.displayName,
    };
    if (payload.exp !== undefined) request.accessTokenExpiresAt = payload.exp * 1000;
    return true;
  }
}
