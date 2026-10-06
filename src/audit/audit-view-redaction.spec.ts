import { redactEntry } from './audit-view-redaction.js';

describe('redactEntry', () => {
  const deleted = {
    action: 'COMMENT_DELETED' as const,
    context: { commentId: 'c1', author: 'Mia', excerpt: 'rude words' },
  };
  const added = {
    action: 'COMMENT_ADDED' as const,
    context: { commentId: 'c1', excerpt: 'rude words' },
  };

  it('strips the text and author of a deleted comment in the feed', () => {
    const feed = { deletedCommentIds: new Set(['c1']) };
    expect(redactEntry(deleted, { feed }).context).toEqual({ commentId: 'c1' });
    expect(redactEntry(added, { feed }).context).toEqual({ commentId: 'c1' });
    expect(deleted.context.excerpt).toBe('rude words');
  });

  it('keeps the excerpt of a comment that still exists', () => {
    const feed = { deletedCommentIds: new Set<string>() };
    expect(redactEntry(added, { feed })).toBe(added);
  });

  it('changes nothing outside the feed', () => {
    expect(redactEntry(deleted, {})).toBe(deleted);
  });
});

describe('redactEntry for a failed sign-in', () => {
  const failed = {
    action: 'SIGN_IN_FAILED' as const,
    context: { email: 'a@example.test', reason: 'inactive' },
  };

  it('shows the reason only to a viewer allowed to see sign-in failure reasons', () => {
    expect(redactEntry(failed, { showsSignInFailureReason: true })).toBe(failed);
    expect(redactEntry(failed, { showsSignInFailureReason: false }).context).toEqual({
      email: 'a@example.test',
    });
    expect(redactEntry(failed, {}).context).toEqual({ email: 'a@example.test' });
    expect(failed.context.reason).toBe('inactive');
  });
});
