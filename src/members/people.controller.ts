import { Controller, Get } from '@nestjs/common';
import { CurrentUser, type Principal } from '../auth/principal.js';
import { MembersService, type PersonView } from './members.service.js';

@Controller('people')
export class PeopleController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@CurrentUser() principal: Principal): Promise<PersonView[]> {
    return this.members.people(principal);
  }
}
