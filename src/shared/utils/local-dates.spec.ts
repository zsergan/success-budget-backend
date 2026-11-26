import { calendarDateIn, isCalendarDate, monthPeriodAt, resolveTimeZone } from './local-dates';

describe('isCalendarDate', () => {
  it.each(['2026-09-28', '2028-02-29', '2000-02-29', '1000-01-01', '9999-12-31', '1969-12-31'])(
    'accepts %p',
    (value) => {
      expect(isCalendarDate(value)).toBe(true);
    },
  );

  it.each([
    '2026-02-29',
    '1900-02-29',
    '2026-13-01',
    '2026-09-31',
    '2026-00-10',
    '2026-9-28',
    '2026-09-28T00:00',
    '2026-09-28T00:00:00Z',
    '2026-09-28+03:00',
    ' 2026-09-28',
    '2026-W40',
    '20260928',
    '0999-12-31',
    '+010000-01-01',
    '',
  ])('rejects %p', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });
});

describe('calendarDateIn', () => {
  it('gives the day the instant has in the zone', () => {
    const instant = new Date('2026-10-08T21:30:00.000Z');

    expect(calendarDateIn(instant, 'Europe/Moscow')).toBe('2026-10-09');
    expect(calendarDateIn(instant, 'America/Chicago')).toBe('2026-10-08');
    expect(calendarDateIn(instant, 'UTC')).toBe('2026-10-08');
  });
});

describe('resolveTimeZone', () => {
  it('returns the canonical IANA name', () => {
    expect(resolveTimeZone('Europe/Moscow')).toBe('Europe/Moscow');
    expect(resolveTimeZone('UTC')).toBe('UTC');
    expect(resolveTimeZone('europe/berlin')).toBe('Europe/Berlin');
  });

  it.each(['+03:00', '-05:00', 'Mars/Olympus', '', 'MSK+1'])('rejects %p', (value) => {
    expect(resolveTimeZone(value)).toBeNull();
  });
});

describe('monthPeriodAt', () => {
  it('returns the calendar month current at the instant in the zone', () => {
    expect(monthPeriodAt(new Date('2026-09-30T21:30:00.000Z'), 'Europe/Moscow')).toEqual({
      time_zone: 'Europe/Moscow',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
    });
    expect(monthPeriodAt(new Date('2026-09-30T21:30:00.000Z'), 'America/Chicago')).toEqual({
      time_zone: 'America/Chicago',
      start_date: '2026-09-01',
      end_date: '2026-09-30',
    });
  });

  it('knows leap years', () => {
    expect(monthPeriodAt(new Date('2028-02-10T12:00:00.000Z'), 'UTC').end_date).toBe('2028-02-29');
  });
});
