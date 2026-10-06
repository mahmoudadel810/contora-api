import { compare, hash } from 'bcryptjs';
import { Types } from 'mongoose';
import type { AuditService } from '../audit/audit.service.js';
import type { UsersRepository } from '../users/users.repository.js';
import { AuthService } from './auth.service.js';
import type { SessionsService } from './sessions.service.js';
import type { TokensService } from './tokens.service.js';

vi.mock('bcryptjs', { spy: true });

const BCRYPT_COST_10 = /^\$2[aby]\$10\$/;

function serviceWith(user: Record<string, unknown> | null) {
  const users = { findByEmailAcrossTenants: vi.fn().mockResolvedValue(user) };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new AuthService(
    users as unknown as UsersRepository,
    {} as never,
    {} as TokensService,
    {} as SessionsService,
    audit as unknown as AuditService,
  );
  return { service, audit };
}

describe('AuthService.signIn timing', () => {
  beforeEach(() => {
    vi.mocked(compare).mockClear();
  });

  it('still runs a bcrypt comparison when the email is unknown', async () => {
    const { service, audit } = serviceWith(null);
    await expect(
      service.signIn({ email: 'nobody@example.test', password: 'guess-password' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(compare).toHaveBeenCalledTimes(1);
    const [password, againstHash] = vi.mocked(compare).mock.calls[0];
    expect(password).toBe('guess-password');
    expect(againstHash).toMatch(BCRYPT_COST_10);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('also compares for an inactive account, and refuses it even with the right password', async () => {
    const passwordHash = await hash('right-password', 10);
    const { service, audit } = serviceWith({
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      email: 'gone@example.test',
      displayName: 'Gone',
      status: 'removed',
      passwordHash,
    });
    await expect(
      service.signIn({ email: 'gone@example.test', password: 'right-password' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(vi.mocked(compare).mock.calls[0][1]).toBe(passwordHash);
    expect(audit.record).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: 'SIGN_IN_FAILED',
        context: { email: 'gone@example.test', reason: 'inactive' },
      }),
    );
  });
});

describe('AuthService.signIn failure reason', () => {
  async function failedReason(status: string, password: string): Promise<unknown> {
    const { service, audit } = serviceWith({
      _id: new Types.ObjectId(),
      tenantId: new Types.ObjectId(),
      email: 'someone@example.test',
      displayName: 'Someone',
      status,
      passwordHash: await hash('right-password', 4),
    });
    await expect(service.signIn({ email: 'someone@example.test', password })).rejects.toMatchObject(
      { code: 'UNAUTHENTICATED' },
    );
    const [, entry] = audit.record.mock.calls[0] as [string, { context: { reason: unknown } }];
    return entry.context.reason;
  }

  it('is "credentials" for an active account with a wrong password', async () => {
    expect(await failedReason('active', 'wrong-password')).toBe('credentials');
  });

  it('is "inactive" for an inactive account whether or not the password matched', async () => {
    expect(await failedReason('removed', 'right-password')).toBe('inactive');
    expect(await failedReason('removed', 'wrong-password')).toBe('inactive');
    expect(await failedReason('suspended', 'right-password')).toBe('inactive');
    expect(await failedReason('suspended', 'wrong-password')).toBe('inactive');
  });
});
