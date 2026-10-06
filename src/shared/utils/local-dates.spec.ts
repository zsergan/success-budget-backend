import { isLocalDate, monthPeriodAt, resolveTimeZone } from './local-dates';

describe('isLocalDate', () => {
  it.each(['2026-09-28', '2028-02-29'])('accepts %p', (value) => {
    expect(isLocalDate(value)).toBe(true);
  });

  it.each(['2026-02-29', '2026-13-01', '2026-09-31', '2026-9-28', '2026-09-28T00:00', '2026-W40', '20260928', ''])(
    'rejects %p',
    (value) => {
      expect(isLocalDate(value)).toBe(false);
    },
  );
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
  it('returns the month of the instant in the zone, to the millisecond', () => {
    expect(monthPeriodAt(new Date('2026-09-30T21:30:00.000Z'), 'Europe/Moscow')).toEqual({
      time_zone: 'Europe/Moscow',
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      from: new Date('2026-09-30T21:00:00.000Z'),
      to: new Date('2026-10-31T20:59:59.999Z'),
    });
  });

  it('follows a DST change inside the month', () => {
    const period = monthPeriodAt(new Date('2026-03-15T12:00:00.000Z'), 'America/New_York');

    expect(period.from).toEqual(new Date('2026-03-01T05:00:00.000Z'));
    expect(period.to).toEqual(new Date('2026-04-01T03:59:59.999Z'));
    expect(period.end_date).toBe('2026-03-31');
  });
});
