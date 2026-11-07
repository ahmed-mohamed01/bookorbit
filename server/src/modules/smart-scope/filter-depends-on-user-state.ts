import type { GroupRule, Rule, StaticRuleField } from '@bookorbit/types';

const USER_STATE_FIELDS = new Set<StaticRuleField>(['rating', 'readStatus', 'startedAt', 'finishedAt', 'readProgress', 'collection', 'seriesStatus']);

export function filterDependsOnUserState(rule: GroupRule | Rule): boolean {
  return rule.type === 'group' ? rule.rules.some(filterDependsOnUserState) : USER_STATE_FIELDS.has(rule.field as StaticRuleField);
}
