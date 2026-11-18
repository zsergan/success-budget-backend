import { HttpStatus } from '@nestjs/common';

import type { Transaction } from '@entities/transaction.entity';
import type { SpaceMember } from '@entities/space-member.entity';
import { AssignmentKind } from '@shared/enums';
import { ApiException } from '@shared/api.exception';
import type { TransactionAssignmentDto } from './dto/transaction-assignment.dto';

export type AssignmentColumns = Pick<Transaction, 'assignment_kind' | 'assigned_user_id'>;

export const toAssignmentColumns = (assignment: TransactionAssignmentDto): AssignmentColumns => ({
  assignment_kind: assignment.kind,
  assigned_user_id: assignment.kind === AssignmentKind.MEMBER ? assignment.user_id! : null,
});

export const isSameAssignment = (a: AssignmentColumns, b: AssignmentColumns): boolean =>
  a.assignment_kind === b.assignment_kind && a.assigned_user_id === b.assigned_user_id;

// the user whose member row a write locks: the one a member assignment names
export const assigneeOf = (assignment: TransactionAssignmentDto | undefined): number | undefined =>
  assignment?.kind === AssignmentKind.MEMBER ? assignment.user_id : undefined;

// For a new or changed assignment only: a stored one may name a former member.
export function assertAssigneeIsMember(assignment: AssignmentColumns, members: ReadonlyMap<number, SpaceMember>): void {
  if (assignment.assignment_kind === AssignmentKind.MEMBER && !members.has(assignment.assigned_user_id!)) {
    throw new ApiException('ASSIGNEE_NOT_MEMBER', HttpStatus.BAD_REQUEST);
  }
}
