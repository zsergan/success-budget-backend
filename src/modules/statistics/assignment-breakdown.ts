import { AssignmentKind, PersonStatus } from '@shared/enums';
import { formatMoney, roundPercentToTenth } from '@shared/utils';
import type { StatisticsAssignmentGroup } from '@modules/transaction-queries/transaction-queries.service';
import { DELETED_MEMBER_KEY, memberKey } from '@modules/transaction-queries/assignment-filter';
import { MAX_PRIMARY_GROUPS, foldGroups, sumOf } from './statistics-breakdown';

export type AssignmentItemKind = AssignmentKind | typeof DELETED_MEMBER_KEY;

export interface AssignmentItem {
  kind: AssignmentItemKind;
  // the feed assignment filter value
  key: string;
  user_id: number | null;
  name: string | null;
  status: PersonStatus.MEMBER | PersonStatus.FORMER_MEMBER | null;
  amount: string;
  percent: number;
  opens_history: true;
}

export interface AssignmentOtherItem {
  kind: 'other';
  key: 'other';
  amount: string;
  percent: number;
  opens_history: false;
  children: AssignmentItem[];
}

export interface AssignmentBreakdown {
  total_amount: string;
  source_count: number;
  primary_items: AssignmentItem[];
  other: AssignmentOtherItem | null;
}

// the order of equal sums: members by user id, then the groups without a user
const RANK: Record<AssignmentItemKind, number> = {
  [AssignmentKind.MEMBER]: 0,
  [DELETED_MEMBER_KEY]: 1,
  [AssignmentKind.SPACE]: 2,
  [AssignmentKind.UNASSIGNED]: 3,
};

interface RankedGroup {
  // foldGroups orders ties by id: members by user id, deleted accounts after them
  id: number;
  amount: bigint;
  group: StatisticsAssignmentGroup;
}

const byAmount = (a: RankedGroup, b: RankedGroup): number =>
  a.amount === b.amount ? RANK[a.group.kind] - RANK[b.group.kind] || a.id - b.id : a.amount > b.amount ? -1 : 1;

// The whole space and nobody are never folded into Other: each is one
// primary item whenever its sum is positive, and takes one of the slots.
// Members, former members and deleted accounts fold by the rules of the
// other groupings, against the whole total.
export const buildAssignmentBreakdown = (groups: StatisticsAssignmentGroup[]): AssignmentBreakdown => {
  const ranked = groups.map((group) => ({
    id: group.userId ?? Number.MAX_SAFE_INTEGER,
    amount: group.amount,
    group,
  }));
  const total = sumOf(ranked);
  const isSpecial = ({ group }: RankedGroup) =>
    group.kind === AssignmentKind.SPACE || group.kind === AssignmentKind.UNASSIGNED;
  const special = ranked.filter((item) => isSpecial(item) && item.amount > 0n);
  const { primary, folded } = foldGroups(
    ranked.filter((item) => !isSpecial(item)),
    total,
    Math.max(MAX_PRIMARY_GROUPS - special.length, 0),
  );
  const toItem = ({ group }: RankedGroup): AssignmentItem => ({
    kind: group.kind,
    key: group.kind === AssignmentKind.MEMBER ? memberKey(group.userId!) : group.kind,
    user_id: group.kind === AssignmentKind.MEMBER ? group.userId : null,
    name: group.kind === AssignmentKind.MEMBER ? group.name : null,
    status:
      group.kind === AssignmentKind.MEMBER ? (group.isMember ? PersonStatus.MEMBER : PersonStatus.FORMER_MEMBER) : null,
    amount: formatMoney(group.amount),
    percent: roundPercentToTenth(group.amount, total),
    opens_history: true,
  });
  const otherSum = sumOf(folded);

  return {
    total_amount: formatMoney(total),
    source_count: primary.length + folded.length + special.length,
    primary_items: [...primary, ...special].sort(byAmount).map(toItem),
    other: folded.length
      ? {
          kind: 'other',
          key: 'other',
          amount: formatMoney(otherSum),
          percent: roundPercentToTenth(otherSum, total),
          opens_history: false,
          children: [...folded].sort(byAmount).map(toItem),
        }
      : null,
  };
};
