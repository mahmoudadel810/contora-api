import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import type { OpenApiDocument } from './openapi.js';
import { ApiReferenceService } from './api-reference.service.js';

@Controller()
export class ApiReferenceController {
  constructor(private readonly reference: ApiReferenceService) {}

  @Public()
  @Get('openapi.json')
  openApi(): OpenApiDocument {
    return this.reference.reference().document;
  }

  @Public()
  @Get('reference')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return this.reference.html();
  }
}
