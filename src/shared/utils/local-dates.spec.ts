import {
  endOfLocalDay,
  formatLocalDate,
  isoWeekday,
  localDayAt,
  parseLocalDate,
  resolveTimeZone,
  startOfLocalDay,
} from './local-dates';

const day = (value: string) => parseLocalDate(value)!;
const iso = (date: Date) => date.toISOString();

describe('parseLocalDate / formatLocalDate', () => {
  it('round-trips a calendar date', () => {
    expect(formatLocalDate(day('2026-09-28'))).toBe('2026-09-28');
    expect(formatLocalDate(day('2028-02-29'))).toBe('2028-02-29');
  });

  it.each(['2026-02-29', '2026-13-01', '2026-09-31', '2026-9-28', '2026-09-28T00:00', '20260928', ''])(
    'rejects %p',
    (value) => {
      expect(parseLocalDate(value)).toBeNull();
    },
  );
});

describe('isoWeekday', () => {
  it('counts from Monday', () => {
    expect(isoWeekday(day('2026-09-28'))).toBe(0);
    expect(isoWeekday(day('2026-10-04'))).toBe(6);
    expect(isoWeekday(day('1969-12-29'))).toBe(0);
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

describe('localDayAt', () => {
  it('reads the calendar date in the zone, not in UTC', () => {
    const instant = new Date('2026-09-27T21:30:00.000Z');

    expect(formatLocalDate(localDayAt(instant, 'Europe/Moscow'))).toBe('2026-09-28');
    expect(formatLocalDate(localDayAt(instant, 'UTC'))).toBe('2026-09-27');
  });
});

describe('startOfLocalDay / endOfLocalDay', () => {
  it.each([
    ['Europe/Moscow', '2026-09-28', '2026-09-27T21:00:00.000Z', '2026-09-28T20:59:59.999Z'],
    ['UTC', '2026-09-28', '2026-09-28T00:00:00.000Z', '2026-09-28T23:59:59.999Z'],
    ['Asia/Kathmandu', '2026-09-28', '2026-09-27T18:15:00.000Z', '2026-09-28T18:14:59.999Z'],
    ['Pacific/Kiritimati', '2026-09-28', '2026-09-27T10:00:00.000Z', '2026-09-28T09:59:59.999Z'],
    ['Etc/GMT+12', '2026-09-28', '2026-09-28T12:00:00.000Z', '2026-09-29T11:59:59.999Z'],
    // 25-hour day: DST ends
    ['Europe/Berlin', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T22:59:59.999Z'],
    // 23-hour day: DST starts
    ['Europe/Berlin', '2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T21:59:59.999Z'],
    // midnight skipped: the day starts at 01:00 local
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T02:59:59.999Z'],
  ])('%s %s', (timeZone, date, start, end) => {
    expect(iso(startOfLocalDay(day(date), timeZone))).toBe(start);
    expect(iso(endOfLocalDay(day(date), timeZone))).toBe(end);
  });

  it('gives a skipped calendar day no length', () => {
    const skipped = day('2011-12-30');

    expect(startOfLocalDay(skipped, 'Pacific/Apia')).toEqual(startOfLocalDay(skipped + 1, 'Pacific/Apia'));
  });
});
