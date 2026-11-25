import { DateTime } from 'luxon';

import { MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from '@shared/utils';

// A calendar date without a zone, held as midnight UTC, so the calendar
// arithmetic never meets DST. Only `today` meets a zone.
export type CalendarDate = DateTime<true>;

export interface DateRange {
  start: CalendarDate;
  end: CalendarDate;
}

export type CalendarUnit = 'day' | 'week' | 'month' | 'year';

export type TimeState = 'past' | 'current' | 'future';

const PLURAL = { day: 'days', week: 'weeks', month: 'months', year: 'years' } as const;

const KEY_FORMAT: Record<CalendarUnit, string> = {
  day: 'yyyy-MM-dd',
  week: "kkkk-'W'WW",
  month: 'yyyy-MM',
  year: 'yyyy',
};

export const parseCalendarDate = (value: string): CalendarDate => {
  const date = DateTime.fromISO(value, { zone: 'utc' });

  if (!date.isValid) {
    throw new RangeError(`Not a calendar date: ${value}`);
  }

  return date;
};

export const formatCalendarDate = (date: CalendarDate): string => date.toISODate();

export const FIRST_DATE = parseCalendarDate(MIN_CALENDAR_DATE);
export const LAST_DATE = parseCalendarDate(MAX_CALENDAR_DATE);

// The calendar date of the instant in the zone.
export const calendarDateAt = (instant: Date, timeZone: string): CalendarDate => {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });

  return DateTime.utc(local.year, local.month, local.day) as CalendarDate;
};

// Weeks run Monday to Sunday.
export const rangeOf = (unit: CalendarUnit, date: CalendarDate): DateRange => ({
  start: date.startOf(unit),
  end: date.endOf(unit).startOf('day'),
});

// A day of month missing in the target month is clamped to its last day
// (Mar 31 → Feb 28, Feb 29 → Feb 28).
export const shift = (date: CalendarDate, unit: CalendarUnit, amount: number): CalendarDate =>
  date.plus({ [PLURAL[unit]]: amount });

export const daysIn = (range: DateRange): number => range.end.diff(range.start, 'days').days + 1;

// Calendar units covering the range, the first and the last clipped to it.
export const splitRange = (range: DateRange, unit: CalendarUnit): DateRange[] => {
  const parts: DateRange[] = [];

  for (let start = range.start; start <= range.end; start = shift(start.startOf(unit), unit, 1)) {
    const end = rangeOf(unit, start).end;
    parts.push({ start, end: end < range.end ? end : range.end });
  }

  return parts;
};

// Stable across requests: 2026-09-28, 2026-W40 (ISO week), 2026-09, 2026.
export const unitKey = (date: CalendarDate, unit: CalendarUnit): string => date.toFormat(KEY_FORMAT[unit]);

export const timeState = ({ start, end }: DateRange, today: CalendarDate): TimeState =>
  today < start ? 'future' : today > end ? 'past' : 'current';

export const earlier = (a: CalendarDate, b: CalendarDate): CalendarDate => (a < b ? a : b);
