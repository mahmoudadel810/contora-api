import { ACTIONS, activityScope, can } from './policy.js';

describe('can', () => {
  it('lets an Admin do everything', () => {
    for (const action of ACTIONS) expect(can({ role: 'admin' }, action)).toBe(true);
  });

  it('lets a Member work with records but not administer the tenant', () => {
    const member = { role: 'member' as const };
    for (const action of [
      'records.write',
      'records.checkout',
      'folders.write',
      'folders.trash',
      'contentTypes.read',
    ] as const) {
      expect(can(member, action)).toBe(true);
    }
    for (const action of [
      'contentTypes.manage',
      'members.manage',
      'invitations.manage',
      'trash.purge',
      'records.forceRelease',
      'audit.readAll',
      'tenant.update',
      'admin.overview',
      'sessions.manage',
      'access.manage',
      'members.read',
      'audit.read',
    ] as const) {
      expect(can(member, action)).toBe(false);
    }
  });
});

describe('activityScope', () => {
  it('shows an Admin the tenant-wide activity', () => {
    expect(activityScope({ role: 'admin' })).toBe('tenant');
  });

  it('shows a Member only their own activity', () => {
    expect(activityScope({ role: 'member' })).toBe('own');
  });
});

describe('share link actions', () => {
  it('lets a Member create links and revoke their own, but only an Admin manage every link', () => {
    const member = { role: 'member' as const };
    expect(can(member, 'shareLinks.create')).toBe(true);
    expect(can(member, 'shareLinks.revokeOwn')).toBe(true);
    expect(can(member, 'shareLinks.manageAll')).toBe(false);
    for (const action of [
      'shareLinks.create',
      'shareLinks.revokeOwn',
      'shareLinks.manageAll',
    ] as const) {
      expect(can({ role: 'admin' }, action)).toBe(true);
    }
  });
});
