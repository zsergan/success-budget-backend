import { getStartOfMonth, getEndOfMonth } from './dates';

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
