import { DateTime } from 'luxon';

// A calendar date without a zone, held as midnight UTC. It turns into
// instants only through startOfDay/endOfDay in the requested zone, so the
// calendar arithmetic never meets DST.
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

export const calendarDateAt = (instant: Date, timeZone: string): CalendarDate => {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });

  return DateTime.utc(local.year, local.month, local.day) as CalendarDate;
};

// First existing instant of the local day: luxon moves a midnight that falls
// into a DST gap to the end of the gap. A day skipped entirely by the zone
// starts together with the next one and has no length.
export const startOfDay = (date: CalendarDate, timeZone: string): Date =>
  DateTime.fromObject({ year: date.year, month: date.month, day: date.day }, { zone: timeZone }).toJSDate();

export const endOfDay = (date: CalendarDate, timeZone: string): Date =>
  new Date(startOfDay(date.plus({ days: 1 }), timeZone).getTime() - 1);

// Weeks run Monday to Sunday.
export const rangeOf = (unit: CalendarUnit, date: CalendarDate): DateRange => ({
  start: date.startOf(unit),
  end: date.endOf(unit).startOf('day'),
});

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

// The same local wall-clock moment one unit earlier; a day of month missing
// there is clamped to the last one (Mar 31 → Feb 28, Feb 29 → Feb 28).
export const shiftInstant = (instant: Date, timeZone: string, unit: CalendarUnit, amount: number): Date =>
  DateTime.fromJSDate(instant, { zone: timeZone })
    .plus({ [PLURAL[unit]]: amount })
    .toJSDate();

export const timeState = (from: Date, to: Date, asOf: Date): TimeState =>
  asOf < from ? 'future' : asOf > to ? 'past' : 'current';
