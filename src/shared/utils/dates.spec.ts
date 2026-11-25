import { parseIsoDate } from './dates';

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
