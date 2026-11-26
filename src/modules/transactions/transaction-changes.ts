import { BadRequestException } from '@nestjs/common';

import type { Transaction } from '@entities/transaction.entity';
import type { TransactionType } from '@shared/enums';
import { parseMoney, resolveTimeZone } from '@shared/utils';
import type { TransactionAssignmentDto } from './dto/transaction-assignment.dto';
import { type AssignmentColumns, isSameAssignment, toAssignmentColumns } from './transaction-assignment';
import {
  AMOUNT_NOT_POSITIVE,
  DATE_AFTER_TODAY,
  isNotAfterToday,
  isPositiveAmount,
  normalizeDescription,
} from './transaction-rules';

export interface TransactionEdit {
  category_id?: number;
  transaction_type?: TransactionType;
  amount?: string;
  date?: string;
  // required with date: tells which day is today for the writer
  time_zone?: string;
  description?: string | null;
  assignment?: TransactionAssignmentDto;
}

export type TransactionChanges = Partial<
  Pick<Transaction, 'category_id' | 'transaction_type' | 'amount' | 'date' | 'description'> & AssignmentColumns
>;

// Equality is by value: a field equal to the stored one is not a change.
// The author is never among them.
export function changedFields(original: Transaction, edit: TransactionEdit): TransactionChanges {
  const changes: TransactionChanges = {};

  if (edit.category_id !== undefined && edit.category_id !== original.category_id) {
    changes.category_id = edit.category_id;
  }

  if (edit.transaction_type !== undefined && edit.transaction_type !== original.transaction_type) {
    changes.transaction_type = edit.transaction_type;
  }

  if (edit.amount !== undefined && parseMoney(edit.amount) !== parseMoney(original.amount)) {
    changes.amount = edit.amount;
  }

  if (edit.date !== undefined && edit.date !== original.date) {
    changes.date = edit.date;
  }

  const description = normalizeDescription(edit.description);

  if (edit.description !== undefined && description !== normalizeDescription(original.description)) {
    changes.description = description;
  }

  if (edit.assignment !== undefined) {
    const assignment = toAssignmentColumns(edit.assignment);

    if (!isSameAssignment(assignment, original)) {
      Object.assign(changes, assignment);
    }
  }

  return changes;
}

// `edit` is the request the changes come from: a changed date has its time_zone.
export function assertNewValues(changes: TransactionChanges, edit: TransactionEdit): void {
  if (changes.amount !== undefined && !isPositiveAmount(changes.amount)) {
    throw new BadRequestException([{ field: 'amount', error: AMOUNT_NOT_POSITIVE }]);
  }

  if (changes.date !== undefined && !isNotAfterToday(changes.date, resolveTimeZone(edit.time_zone!)!)) {
    throw new BadRequestException([{ field: 'date', error: DATE_AFTER_TODAY }]);
  }
}
