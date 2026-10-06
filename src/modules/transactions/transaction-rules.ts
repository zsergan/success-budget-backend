import { CLOCK_SKEW_MS } from '@shared/constants';
import { parseMoneyInput, toDate } from '@shared/utils';

// Rules for a new or changed value. Values already stored under older rules
// (a zero amount, a future timestamp) are kept as long as they do not change.

export const MAX_DESCRIPTION_LENGTH = 140;

export const AMOUNT_NOT_POSITIVE = 'amount must be greater than 0';
export const TIMESTAMP_IN_FUTURE = 'timestamp must not be in the future';

export const isPositiveAmount = (amount: string): boolean => (parseMoneyInput(amount) ?? 0n) > 0n;

export const isNotInFuture = (timestamp: string, now = Date.now()): boolean =>
  toDate(timestamp).getTime() <= now + CLOCK_SKEW_MS;

// trimmed; blank means no description
export const normalizeDescription = (value: string | null | undefined): string | null => value?.trim() || null;
