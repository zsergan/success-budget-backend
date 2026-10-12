import { getStartOfMonth, getEndOfMonth, parseIsoDate, toDate } from './dates';

describe('getStartOfMonth', () => {
  it('returns the first day of the month at local midnight', () => {
    const result = getStartOfMonth(new Date(2026, 2, 17, 13, 45));

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(1);
    expect(result.getHours()).toBe(0);
  });

  it('handles January correctly without rolling back a year', () => {
    const result = getStartOfMonth(new Date(2026, 0, 15));

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });
});

describe('getEndOfMonth', () => {
  it('returns the last day of a 31-day month', () => {
    const result = getEndOfMonth(new Date(2026, 0, 5));

    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(31);
  });

  it('returns the last day of February in a leap year', () => {
    const result = getEndOfMonth(new Date(2028, 1, 10));

    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(29);
  });

  it('returns the last day of February in a non-leap year', () => {
    const result = getEndOfMonth(new Date(2026, 1, 10));

    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });

  it('handles December correctly without rolling forward a year', () => {
    const result = getEndOfMonth(new Date(2026, 11, 5));

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(11);
    expect(result.getDate()).toBe(31);
  });
});

describe('parseIsoDate', () => {
  it('reads a date-only value as local midnight', () => {
    expect(parseIsoDate('2026-01-15')).toEqual(new Date(2026, 0, 15));
  });

  it('reads a date-time without an offset as local time', () => {
    expect(parseIsoDate('2026-01-15T10:30')).toEqual(new Date(2026, 0, 15, 10, 30));
    expect(parseIsoDate('2026-01-15 10:30:00')).toEqual(new Date(2026, 0, 15, 10, 30));
  });

  it('reads Z and explicit offsets as exact instants, keeping milliseconds', () => {
    expect(parseIsoDate('2026-01-15T10:30:00.123Z')?.toISOString()).toBe('2026-01-15T10:30:00.123Z');
    expect(parseIsoDate('2026-01-15T10:30:00.5+03:00')?.toISOString()).toBe('2026-01-15T07:30:00.500Z');
    expect(parseIsoDate('2026-01-15T10:30:00-0530')?.toISOString()).toBe('2026-01-15T16:00:00.000Z');
  });

  it.each(['', 'garbage', '2026-02-30', '2026-13-01', '2026', '2026-01', '20260115', '2026-W03', '1700000000000'])(
    'rejects %p',
    (value) => {
      expect(parseIsoDate(value)).toBeNull();
    },
  );
});

describe('toDate', () => {
  it('throws on a value that was not validated as an ISO date', () => {
    expect(() => toDate('garbage')).toThrow(TypeError);
  });
});
