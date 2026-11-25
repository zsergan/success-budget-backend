import { CLOCK_SKEW_MS } from '@shared/constants';
import { calendarDateIn, parseMoneyInput } from '@shared/utils';

// Rules for a new or changed value. Values already stored under older rules
// (a zero amount, a date after today) are kept as long as they do not change.

export const MAX_DESCRIPTION_LENGTH = 140;

export const AMOUNT_NOT_POSITIVE = 'amount must be greater than 0';
export const DATE_AFTER_TODAY = 'date must not be after today in time_zone';
export const TIME_ZONE_REQUIRED = 'time_zone is required with date';

export const isPositiveAmount = (amount: string): boolean => (parseMoneyInput(amount) ?? 0n) > 0n;

// Today in the writer's zone, by a server clock moved ahead by the margin
// for a device clock that is a little ahead of it.
export const todayIn = (timeZone: string, now = Date.now()): string =>
  calendarDateIn(new Date(now + CLOCK_SKEW_MS), timeZone);

// both calendar dates: compared as strings
export const isNotAfterToday = (date: string, timeZone: string, now = Date.now()): boolean =>
  date <= todayIn(timeZone, now);

// trimmed; blank means no description
export const normalizeDescription = (value: string | null | undefined): string | null => value?.trim() || null;

export const MAX_SEARCH_LENGTH = 255;
export const SEARCH_TOO_LONG = `q must be at most ${MAX_SEARCH_LENGTH} characters`;

// trimmed, inner whitespace kept; blank means no search
export const normalizeSearch = (value: string): string | undefined => value.trim() || undefined;

// in code points, so an emoji outside the BMP counts as one
export const isSearchWithinLimit = (value: string): boolean => [...value].length <= MAX_SEARCH_LENGTH;
