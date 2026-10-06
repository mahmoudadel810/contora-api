import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { errors } from '../common/errors.js';
import type { Role } from '../users/role.js';

export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  displayName: string;
}

export interface Actor {
  id: string;
  email: string;
  displayName: string;
}

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
  accessTokenExpiresAt?: number;
}

export function actorOf(principal: Principal): Actor {
  return {
    id: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
  };
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const request = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
  if (!request.principal) throw errors.unauthorized();
  return request.principal;
});
