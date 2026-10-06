import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { AdminService, type AdminOverview } from './admin.service.js';

@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview(@CurrentUser() principal: Principal): Promise<AdminOverview> {
    return this.admin.overview(principal);
  }
}
