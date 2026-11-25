import {
  calendarDateAt,
  daysIn,
  formatCalendarDate,
  parseCalendarDate,
  rangeOf,
  shift,
  splitRange,
  timeState,
  unitKey,
} from './statistics-calendar';

const date = parseCalendarDate;
const range = (start: string, end: string) => ({ start: date(start), end: date(end) });
const dates = (parts: { start: ReturnType<typeof date>; end: ReturnType<typeof date> }[]) =>
  parts.map((part) => `${formatCalendarDate(part.start)}..${formatCalendarDate(part.end)}`);

describe('statistics calendar', () => {
  it('rejects an impossible date', () => {
    expect(() => date('2026-02-29')).toThrow(RangeError);
  });

  it('reads the calendar date in the zone, not in UTC', () => {
    const instant = new Date('2026-09-27T21:30:00.000Z');

    expect(formatCalendarDate(calendarDateAt(instant, 'Europe/Moscow'))).toBe('2026-09-28');
    expect(formatCalendarDate(calendarDateAt(instant, 'UTC'))).toBe('2026-09-27');
  });

  describe('rangeOf', () => {
    it.each([
      ['week', '2026-10-01', '2026-09-28..2026-10-04'],
      ['week', '2027-01-01', '2026-12-28..2027-01-03'],
      ['month', '2028-02-10', '2028-02-01..2028-02-29'],
      ['month', '2026-02-10', '2026-02-01..2026-02-28'],
      ['month', '2026-12-31', '2026-12-01..2026-12-31'],
      ['year', '2025-06-15', '2025-01-01..2025-12-31'],
    ] as const)('%s containing %s is %s', (unit, day, expected) => {
      expect(dates([rangeOf(unit, date(day))])).toEqual([expected]);
    });
  });

  it('counts days inclusively', () => {
    expect(daysIn(range('2026-09-01', '2026-09-01'))).toBe(1);
    expect(daysIn(range('2028-01-01', '2028-12-31'))).toBe(366);
  });

  describe('splitRange', () => {
    it('splits a month into Monday weeks clipped to it', () => {
      expect(dates(splitRange(range('2026-09-01', '2026-09-30'), 'week'))).toEqual([
        '2026-09-01..2026-09-06',
        '2026-09-07..2026-09-13',
        '2026-09-14..2026-09-20',
        '2026-09-21..2026-09-27',
        '2026-09-28..2026-09-30',
      ]);
    });

    it('gives a month 4 to 6 weeks', () => {
      // February 2027 starts on a Monday and has exactly four weeks
      expect(splitRange(range('2027-02-01', '2027-02-28'), 'week')).toHaveLength(4);
      // August 2027 starts on a Sunday and ends on a Tuesday
      expect(splitRange(range('2027-08-01', '2027-08-31'), 'week')).toHaveLength(6);
    });

    it('crosses a year boundary without losing or doubling a day', () => {
      expect(dates(splitRange(range('2026-12-30', '2027-01-05'), 'week'))).toEqual([
        '2026-12-30..2027-01-03',
        '2027-01-04..2027-01-05',
      ]);
      expect(dates(splitRange(range('2026-11-15', '2027-02-10'), 'month'))).toEqual([
        '2026-11-15..2026-11-30',
        '2026-12-01..2026-12-31',
        '2027-01-01..2027-01-31',
        '2027-02-01..2027-02-10',
      ]);
    });

    it('splits a year into its months, whatever their length', () => {
      const months = splitRange(range('2028-01-01', '2028-12-31'), 'month');

      expect(months.map(daysIn)).toEqual([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    });
  });

  it('keys units in ISO notation', () => {
    expect(unitKey(date('2026-09-28'), 'day')).toBe('2026-09-28');
    expect(unitKey(date('2026-09-28'), 'week')).toBe('2026-W40');
    // the ISO week year differs from the calendar year here
    expect(unitKey(date('2026-12-30'), 'week')).toBe('2026-W53');
    expect(unitKey(date('2027-12-28'), 'week')).toBe('2027-W52');
    expect(unitKey(date('2025-12-30'), 'week')).toBe('2026-W01');
    expect(unitKey(date('2026-09-28'), 'month')).toBe('2026-09');
  });

  describe('shift', () => {
    it.each([
      ['2026-09-28', 'week', '2026-09-21'],
      ['2026-09-28', 'month', '2026-08-28'],
      // a missing day is clamped to the last day of the shorter month
      ['2026-03-31', 'month', '2026-02-28'],
      ['2026-10-31', 'month', '2026-09-30'],
      ['2028-03-31', 'month', '2028-02-29'],
      ['2028-02-29', 'year', '2027-02-28'],
      ['2027-01-03', 'week', '2026-12-27'],
    ] as const)('%s one %s earlier is %s', (day, unit, expected) => {
      expect(formatCalendarDate(shift(date(day), unit, -1))).toBe(expected);
    });

    it('never meets DST: a day before the change is a day before', () => {
      expect(formatCalendarDate(shift(date('2026-10-26'), 'day', -1))).toBe('2026-10-25');
      expect(formatCalendarDate(shift(date('2026-03-30'), 'week', -1))).toBe('2026-03-23');
    });
  });

  it('tells past, current and future by today, its own day included', () => {
    const week = range('2026-09-28', '2026-10-04');

    expect(timeState(week, date('2026-09-27'))).toBe('future');
    expect(timeState(week, date('2026-09-28'))).toBe('current');
    expect(timeState(week, date('2026-10-04'))).toBe('current');
    expect(timeState(week, date('2026-10-05'))).toBe('past');
  });
});
