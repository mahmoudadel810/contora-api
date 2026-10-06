import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { DashboardService, type DashboardView } from './dashboard.service.js';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary(@CurrentUser() principal: Principal): Promise<DashboardView> {
    return this.dashboard.summary(principal);
  }
}
