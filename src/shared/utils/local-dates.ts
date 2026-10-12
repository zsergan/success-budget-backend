import { DateTime } from 'luxon';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_OFFSET = /^[+-]/;

export const isLocalDate = (value: string): boolean =>
  LOCAL_DATE.test(value) && DateTime.fromISO(value, { zone: 'utc' }).isValid;

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
  start_date: string; // local dates, inclusive
  end_date: string;
  from: Date; // instants, inclusive, to the millisecond
  to: Date;
}

export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The calendar month containing `now` in the zone.
export const monthPeriodAt = (now: Date, timeZone: string): MonthPeriod => {
  const start = DateTime.fromJSDate(now, { zone: timeZone }).startOf('month');
  const next = start.plus({ months: 1 });

  return {
    time_zone: timeZone,
    start_date: start.toISODate()!,
    end_date: next.minus({ days: 1 }).toISODate()!,
    from: start.toJSDate(),
    to: new Date(next.toJSDate().getTime() - 1),
  };
};
