import { DateTime } from 'luxon';

// The range of a MySQL DATE, and so of every date the API takes.
export const MIN_CALENDAR_DATE = '1000-01-01';
export const MAX_CALENDAR_DATE = '9999-12-31';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_OFFSET = /^[+-]/;

// Exactly YYYY-MM-DD, a real day. Such strings order like the days they name.
export const isCalendarDate = (value: string): boolean =>
  CALENDAR_DATE.test(value) && value >= MIN_CALENDAR_DATE && DateTime.fromISO(value, { zone: 'utc' }).isValid;

// The calendar date the instant has in the zone.
export const calendarDateIn = (instant: Date, timeZone: string): string =>
  DateTime.fromJSDate(instant, { zone: timeZone }).toISODate()!;

// Canonical IANA name, or null. Fixed offsets are rejected: they ignore DST.
export const resolveTimeZone = (value: string): string | null => {
  if (UTC_OFFSET.test(value)) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

export interface MonthPeriod {
  time_zone: string;
  // calendar dates, inclusive
  start_date: string;
  end_date: string;
}

export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The calendar month that is current at `now` in the zone.
export const monthPeriodAt = (now: Date, timeZone: string): MonthPeriod => {
  const start = DateTime.fromJSDate(now, { zone: timeZone }).startOf('month');

  return {
    time_zone: timeZone,
    start_date: start.toISODate()!,
    end_date: start.endOf('month').toISODate()!,
  };
};
