import { AssignmentKind } from '@shared/enums';
import type { StatisticsAssignmentGroup } from '@modules/transaction-queries/transaction-queries.service';
import { buildAssignmentBreakdown } from './assignment-breakdown';

const member = (userId: number, amount: bigint, isMember = true): StatisticsAssignmentGroup => ({
  kind: AssignmentKind.MEMBER,
  userId,
  name: `User ${userId}`,
  isMember,
  amount,
  count: 1,
});
const special = (
  kind: AssignmentKind.SPACE | AssignmentKind.UNASSIGNED,
  amount: bigint,
): StatisticsAssignmentGroup => ({
  kind,
  userId: null,
  name: null,
  isMember: false,
  amount,
  count: 1,
});
const deleted = (amount: bigint): StatisticsAssignmentGroup => ({
  kind: 'deleted_member',
  userId: null,
  name: null,
  isMember: false,
  amount,
  count: 1,
});

describe('buildAssignmentBreakdown', () => {
  it('adds up the design example exactly, space and unassigned as their own rows', () => {
    const result = buildAssignmentBreakdown([
      member(1, 145000n),
      special(AssignmentKind.SPACE, 110000n),
      member(31, 45000n),
      special(AssignmentKind.UNASSIGNED, 15000n),
    ]);

    expect(result.total_amount).toBe('3150.00');
    expect(result.source_count).toBe(4);
    expect(result.primary_items.map((item) => [item.key, item.amount, item.percent])).toEqual([
      ['member:1', '1450.00', 46],
      ['space', '1100.00', 34.9],
      ['member:31', '450.00', 14.3],
      ['unassigned', '150.00', 4.8],
    ]);
    expect(result.other).toBeNull();
  });

  it('never folds space or unassigned, however small, and folds small members into Other', () => {
    const result = buildAssignmentBreakdown([
      member(1, 300000n),
      member(2, 200n),
      member(3, 100n, false),
      special(AssignmentKind.UNASSIGNED, 100n),
      special(AssignmentKind.SPACE, 50n),
    ]);

    expect(result.primary_items.map((item) => item.key)).toEqual(['member:1', 'unassigned', 'space']);
    expect(result.other).toEqual(
      expect.objectContaining({
        kind: 'other',
        amount: '3.00',
        opens_history: false,
        children: [
          expect.objectContaining({ key: 'member:2', status: 'member', opens_history: true }),
          expect.objectContaining({ key: 'member:3', status: 'former_member' }),
        ],
      }),
    );
    expect(result.source_count).toBe(5);
  });

  it('gives the special groups their slots out of the six primary ones', () => {
    const members = [1, 2, 3, 4, 5, 6].map((id) => member(id, 1000n));
    const result = buildAssignmentBreakdown([
      ...members,
      special(AssignmentKind.SPACE, 1000n),
      special(AssignmentKind.UNASSIGNED, 1000n),
    ]);

    expect(result.primary_items).toHaveLength(6);
    expect(result.primary_items.map((item) => item.key)).toEqual([
      'member:1',
      'member:2',
      'member:3',
      'member:4',
      'space',
      'unassigned',
    ]);
    expect(result.other!.children.map((item) => item.key)).toEqual(['member:5', 'member:6']);
  });

  it('keeps deleted accounts as one foldable group apart from unassigned', () => {
    const result = buildAssignmentBreakdown([deleted(5000n), special(AssignmentKind.UNASSIGNED, 5000n)]);

    expect(result.primary_items).toEqual([
      expect.objectContaining({ kind: 'deleted_member', key: 'deleted_member', user_id: null, status: null }),
      expect.objectContaining({ kind: 'unassigned', key: 'unassigned' }),
    ]);
  });

  it('drops zero sums', () => {
    expect(buildAssignmentBreakdown([member(1, 0n), special(AssignmentKind.SPACE, 0n)])).toEqual({
      total_amount: '0.00',
      source_count: 0,
      primary_items: [],
      other: null,
    });
  });
});
