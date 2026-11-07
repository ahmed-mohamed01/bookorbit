import { RULE_FIELDS, type Rule } from '@bookorbit/types';
import { filterDependsOnUserState } from './filter-depends-on-user-state';

describe('filterDependsOnUserState', () => {
  it.each(RULE_FIELDS)('classifies %s', (field) => {
    expect(filterDependsOnUserState({ type: 'rule', field, operator: 'eq' } as Rule)).toBe(
      ['rating', 'readStatus', 'startedAt', 'finishedAt', 'readProgress', 'collection', 'seriesStatus'].includes(field),
    );
  });
  it('walks nested groups and handles empty groups and custom metadata', () => {
    expect(filterDependsOnUserState({ type: 'group', join: 'OR', rules: [] })).toBe(false);
    expect(filterDependsOnUserState({ type: 'rule', field: 'custom:1', operator: 'eq', value: 'x' })).toBe(false);
    expect(
      filterDependsOnUserState({
        type: 'group',
        join: 'AND',
        rules: [{ type: 'group', join: 'OR', rules: [{ type: 'rule', field: 'readStatus', operator: 'includesAny', value: ['reading'] }] }],
      }),
    ).toBe(true);
  });
});
