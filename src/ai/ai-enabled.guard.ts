import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { errors } from '../common/errors.js';
import { AiAvailability } from './ai-availability.js';

@Injectable()
export class AiEnabledGuard implements CanActivate {
  constructor(private readonly availability: AiAvailability) {}

  canActivate(context: ExecutionContext): boolean {
    const principal = context.switchToHttp().getRequest<RequestWithPrincipal>().principal;
    if (!principal) throw errors.unauthorized();
    this.availability.assertAiAvailable(principal);
    return true;
  }
}
