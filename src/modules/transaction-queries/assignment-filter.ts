import { AssignmentKind } from '@shared/enums';

// The History "Assigned to" filter and the key of an assignment group.
export type AssignmentFilter =
  | { kind: AssignmentKind.MEMBER; userId: number }
  | { kind: AssignmentKind.SPACE }
  | { kind: AssignmentKind.UNASSIGNED }
  // member assignments whose account was deleted since
  | { kind: 'deleted_member' };

export const DELETED_MEMBER_KEY = 'deleted_member';

const MAX_ID = 2147483647;
const MEMBER_KEY = /^member:([1-9]\d{0,9})$/;

export const memberKey = (userId: number): string => `member:${userId}`;

export function assignmentKey(filter: AssignmentFilter): string {
  return filter.kind === AssignmentKind.MEMBER ? memberKey(filter.userId) : filter.kind;
}

// null when the value is not a filter
export function parseAssignmentFilter(value: string): AssignmentFilter | null {
  if (value === AssignmentKind.SPACE || value === AssignmentKind.UNASSIGNED) {
    return { kind: value };
  }

  if (value === DELETED_MEMBER_KEY) {
    return { kind: DELETED_MEMBER_KEY };
  }

  const userId = Number(MEMBER_KEY.exec(value)?.[1]);

  return Number.isSafeInteger(userId) && userId <= MAX_ID ? { kind: AssignmentKind.MEMBER, userId } : null;
}
