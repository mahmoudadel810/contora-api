import { AUDIT_ACTIONS } from './audit-action.js';
import {
  ActionListSchema,
  MAX_ACTION_LIST_LENGTH,
  MAX_ACTION_LIST_TOTAL_LENGTH,
  MAX_ACTION_LIST_VALUES,
  resolveActions,
} from './audit-action-filter.js';

describe('ActionListSchema', () => {
  it('accepts a comma list, repeated values and both, de-duplicated', () => {
    expect(ActionListSchema.parse('SIGN_IN,SIGN_OUT')).toEqual(['SIGN_IN', 'SIGN_OUT']);
    expect(ActionListSchema.parse(['SIGN_IN', 'SIGN_OUT', 'SIGN_IN'])).toEqual([
      'SIGN_IN',
      'SIGN_OUT',
    ]);
    expect(ActionListSchema.parse(['SIGN_IN,RECORD_CREATED', ' SIGN_OUT '])).toEqual([
      'SIGN_IN',
      'RECORD_CREATED',
      'SIGN_OUT',
    ]);
  });

  it('refuses unknown and empty values instead of dropping them', () => {
    for (const bad of ['', 'NOPE', 'SIGN_IN,', 'SIGN_IN,,SIGN_OUT', ['SIGN_IN', ''], 'sign_in']) {
      expect(ActionListSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('bounds the raw string and the number of repeated values', () => {
    expect(ActionListSchema.safeParse('A'.repeat(MAX_ACTION_LIST_LENGTH + 1)).success).toBe(false);
    const many = Array.from({ length: MAX_ACTION_LIST_VALUES + 1 }, () => 'SIGN_IN');
    expect(ActionListSchema.safeParse(many).success).toBe(false);
    expect(ActionListSchema.safeParse(many.slice(1)).success).toBe(true);
  });

  it('bounds the total raw length across repeated values', () => {
    const long = Array.from({ length: 100 }, () => 'SIGN_IN').join(',');
    expect(long.length).toBeLessThanOrEqual(MAX_ACTION_LIST_LENGTH);
    expect(ActionListSchema.safeParse([long, long]).success).toBe(true);
    const tooLong = ActionListSchema.safeParse([long, long, long]);
    expect(3 * long.length).toBeGreaterThan(MAX_ACTION_LIST_TOTAL_LENGTH);
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues.map((issue) => issue.message)).toEqual([
      `At most ${MAX_ACTION_LIST_TOTAL_LENGTH} characters in all`,
    ]);
  });

  it('does not echo a refused value back in the message', () => {
    const result = ActionListSchema.safeParse('SIGN_IN,<script>alert(1)</script>');
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Unknown action']);
    expect(ActionListSchema.safeParse('SIGN_IN,').error?.issues[0].message).toBe('Empty action');
  });

  it('refuses shapes a query parser may produce other than strings', () => {
    expect(ActionListSchema.safeParse({ 0: 'SIGN_IN' }).success).toBe(false);
    expect(ActionListSchema.safeParse(['SIGN_IN', ['SIGN_OUT']]).success).toBe(false);
  });
});

describe('resolveActions', () => {
  it('applies no action clause when nothing is filtered', () => {
    expect(resolveActions({})).toBeNull();
    expect(resolveActions({ excludeActions: [] })).toBeNull();
  });

  it('merges the older single action into the list', () => {
    expect(resolveActions({ action: 'SIGN_UP', actions: ['SIGN_IN'] })).toEqual([
      'SIGN_UP',
      'SIGN_IN',
    ]);
    expect(resolveActions({ action: 'SIGN_UP' })).toEqual(['SIGN_UP']);
  });

  it('lets exclusion win and expresses it as the complement', () => {
    expect(
      resolveActions({ actions: ['SIGN_IN', 'SIGN_OUT'], excludeActions: ['SIGN_IN'] }),
    ).toEqual(['SIGN_OUT']);
    const rest = resolveActions({ excludeActions: ['SIGN_IN', 'SIGN_OUT'] });
    expect(rest).toHaveLength(AUDIT_ACTIONS.length - 2);
    expect(rest).not.toContain('SIGN_IN');
    expect(rest).not.toContain('SIGN_OUT');
  });

  it('returns an empty list when the exclusions leave nothing', () => {
    expect(resolveActions({ actions: ['SIGN_IN'], excludeActions: ['SIGN_IN'] })).toEqual([]);
    expect(resolveActions({ excludeActions: AUDIT_ACTIONS })).toEqual([]);
  });

  it('treats a list of every action like no filter', () => {
    expect(resolveActions({ actions: AUDIT_ACTIONS })).toBeNull();
  });
});
