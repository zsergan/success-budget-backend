import type { Category } from '@entities/category.entity';
import type { User } from '@entities/user.entity';
import type { LoadedTransaction } from '@modules/transaction-queries/transaction-queries.service';
import { AssignmentKind, PersonStatus, TransactionKind } from '@shared/enums';
import type { TransactionCategory } from './dto/transaction-responses';
import type { TransactionAssignmentView, TransactionPerson, TransactionViewV2 } from './dto/transaction-v2-responses';

// Built field by field, so no entity column reaches the client unless listed.
// The author and the assignment are resolved against the users who are
// members of the space now.
export function toTransactionViewV2(transaction: LoadedTransaction, members: ReadonlySet<number>): TransactionViewV2 {
  return {
    id: transaction.id,
    kind: transaction.category.is_system ? TransactionKind.INITIAL_BALANCE : TransactionKind.REGULAR,
    transaction_type: transaction.transaction_type,
    amount: transaction.amount,
    timestamp: transaction.timestamp,
    description: transaction.description?.trim() ? transaction.description : null,
    version: transaction.version,
    category: toCategory(transaction.category),
    author: {
      ...toPerson(transaction.author_user_id, transaction.author, members),
      source: transaction.author_source,
    },
    assignment: toAssignment(transaction, members),
  };
}

function toPerson(
  userId: number | null,
  user: Pick<User, 'name'> | null | undefined,
  members: ReadonlySet<number>,
): TransactionPerson {
  if (userId === null) {
    return { user_id: null, name: null, status: PersonStatus.DELETED };
  }

  return {
    user_id: userId,
    name: user?.name ?? null,
    status: members.has(userId) ? PersonStatus.MEMBER : PersonStatus.FORMER_MEMBER,
  };
}

function toAssignment(transaction: LoadedTransaction, members: ReadonlySet<number>): TransactionAssignmentView {
  if (transaction.assignment_kind !== AssignmentKind.MEMBER) {
    return { kind: transaction.assignment_kind, user_id: null, name: null, status: null };
  }

  return {
    kind: AssignmentKind.MEMBER,
    ...toPerson(transaction.assigned_user_id, transaction.assignedUser, members),
  };
}

function toCategory(category: Category): TransactionCategory {
  return {
    id: category.id,
    name: category.name,
    transaction_type: category.transaction_type,
    icon: category.icon,
    color: category.color,
    is_active: category.is_active,
    is_archived: !category.is_active,
    created_at: category.created_at,
    updated_at: category.updated_at,
  };
}
