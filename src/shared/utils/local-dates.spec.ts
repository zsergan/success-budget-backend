import { isLocalDate, resolveTimeZone } from './local-dates';

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
