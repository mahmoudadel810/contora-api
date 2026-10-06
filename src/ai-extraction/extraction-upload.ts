import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithPrincipal } from '../auth/principal.js';
import { PolicyService } from '../authorization/policy.service.js';
import { errors } from '../common/errors.js';
import { AppExceptionFilter } from '../common/app-exception.filter.js';
import { ExtractionJobsRepository, statusIn } from './ai-extraction-jobs.repository.js';
import { AiAvailability } from './deps.js';
import { extractionErrors } from './extraction-errors.js';
import { IN_FLIGHT_STATUSES, OPEN_STATUSES } from './extraction.types.js';
import {
  BUSY_RETRY_AFTER_SECONDS,
  EXTRACTION_SETTINGS,
  type ExtractionSettings,
} from './extraction-settings.js';

const UPLOAD_LIMIT = Symbol('aiExtractionUploadLimit');

interface UploadLimit {
  fileSize: number;
  maxMb: number;
}

type RequestWithLimit = Request & { [UPLOAD_LIMIT]?: UploadLimit };

const FALLBACK_LIMIT: UploadLimit = { fileSize: 20 * 1024 * 1024, maxMb: 20 };

export function extractionUploadLimits(request: unknown): {
  fileSize: number;
  files: number;
  fields: number;
} {
  const limit = (request as RequestWithLimit)[UPLOAD_LIMIT] ?? FALLBACK_LIMIT;
  return { fileSize: limit.fileSize, files: 1, fields: 20 };
}

@Injectable()
export class ExtractionUploadGuard implements CanActivate {
  constructor(
    private readonly availability: AiAvailability,
    private readonly policy: PolicyService,
    private readonly jobs: ExtractionJobsRepository,
    @Inject(EXTRACTION_SETTINGS) private readonly settings: ExtractionSettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal & RequestWithLimit>();
    const principal = request.principal;
    if (!principal) throw errors.unauthorized();
    this.availability.assertAiAvailable(principal);
    await this.policy.authorize(principal, 'records.write', { type: 'aiExtraction' });
    const owner = { tenantId: principal.tenantId, userId: principal.userId };
    const [userInFlight, userOpen, tenantInFlight] = await Promise.all([
      this.jobs.count(owner, { status: statusIn(IN_FLIGHT_STATUSES) }),
      this.jobs.count(owner, { status: statusIn(OPEN_STATUSES) }),
      this.jobs.countInTenant(principal.tenantId, { status: statusIn(IN_FLIGHT_STATUSES) }),
    ]);
    if (userInFlight >= this.settings.userInFlight || userOpen >= this.settings.userOpenJobs) {
      throw extractionErrors.busy('user', BUSY_RETRY_AFTER_SECONDS);
    }
    if (tenantInFlight >= this.settings.tenantInFlight) {
      throw extractionErrors.busy('tenant', BUSY_RETRY_AFTER_SECONDS);
    }
    request[UPLOAD_LIMIT] = {
      fileSize: this.settings.maxFileBytes,
      maxMb: this.settings.maxFileMb,
    };
    return true;
  }
}

@Catch(PayloadTooLargeException)
export class FileTooLargeFilter implements ExceptionFilter {
  private readonly delegate = new AppExceptionFilter();

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<RequestWithLimit>();
    const limit = request[UPLOAD_LIMIT] ?? FALLBACK_LIMIT;
    this.delegate.catch(extractionErrors.fileTooLarge(limit.maxMb), host);
  }
}
