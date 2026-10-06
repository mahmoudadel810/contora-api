import { DomainEvents, type DomainEvent } from './domain-events.js';

const roleChanged: DomainEvent = {
  type: 'member.roleChanged',
  tenantId: 't',
  actor: { id: 'a', email: 'a@x.io', displayName: 'A' },
  userId: 'u',
  role: 'admin',
};

describe('DomainEvents', () => {
  it('runs handlers in order and keeps going when one fails', async () => {
    const events = new DomainEvents();
    const seen: string[] = [];
    events.subscribe(async () => {
      seen.push('first');
      throw new Error('boom');
    });
    events.subscribe(async (event) => {
      seen.push(`second:${event.type}`);
    });
    await expect(events.emit(roleChanged)).resolves.toBeUndefined();
    expect(seen).toEqual(['first', 'second:member.roleChanged']);
  });
});
