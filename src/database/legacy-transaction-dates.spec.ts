import { DateTime } from 'luxon';

import { assertLegacyZoneData, legacyDateOf, legacyDayStart, nextDate } from './legacy-transaction-dates';

const at = (iso: string) => Date.parse(iso);

describe('legacy transaction dates', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['a winter evening, UTC already the next day', '2026-01-16T05:59:59.999Z', '2026-01-15'],
    ['a winter midnight', '2026-01-16T06:00:00.000Z', '2026-01-16'],
    ['a summer evening, UTC already the next day', '2026-07-16T04:59:59.999Z', '2026-07-15'],
    ['a summer midnight', '2026-07-16T05:00:00.000Z', '2026-07-16'],
    ['the end of a month', '2026-03-01T05:30:00.000Z', '2026-02-28'],
    ['the end of a year', '2027-01-01T05:59:59.999Z', '2026-12-31'],
    ['the night the clocks go forward', '2026-03-08T08:00:00.000Z', '2026-03-08'],
    ['the night the clocks go back', '2026-11-01T06:30:00.000Z', '2026-11-01'],
    ['an evening under the rules before 2007', '2006-04-03T04:59:59.999Z', '2006-04-02'],
  ])('dates %s by its Chicago day', (_case, instant, date) => {
    expect(legacyDateOf(at(instant))).toBe(date);
  });

  it('refuses a value that is not an instant', () => {
    expect(() => legacyDateOf(Number.NaN)).toThrow(RangeError);
  });

  it.each([
    ['a winter day', '2026-01-15', '2026-01-15T06:00:00.000Z'],
    ['a summer day', '2026-07-15', '2026-07-15T05:00:00.000Z'],
    ['the day the clocks go forward', '2026-03-08', '2026-03-08T06:00:00.000Z'],
    ['the day the clocks go back', '2026-11-01', '2026-11-01T05:00:00.000Z'],
  ])('starts %s at Chicago midnight', (_case, date, start) => {
    expect(new Date(legacyDayStart(date)).toISOString()).toBe(start);
  });

  it('refuses a day that does not exist', () => {
    expect(() => legacyDayStart('2026-02-30')).toThrow('Not a calendar date: 2026-02-30');
  });

  it.each([
    ['2026-01-15', '2026-01-16'],
    ['2026-02-28', '2026-03-01'],
    ['2028-02-28', '2028-02-29'],
    ['2026-12-31', '2027-01-01'],
    ['2026-03-08', '2026-03-09'],
  ])('follows %s with %s', (date, next) => {
    expect(nextDate(date)).toBe(next);
  });

  it('accepts the zone data of this Node', () => {
    expect(() => assertLegacyZoneData()).not.toThrow();
  });

  it('refuses a Node that does not know the zone', () => {
    jest.spyOn(DateTime, 'fromISO').mockReturnValue(DateTime.invalid('unsupported zone'));

    expect(() => assertLegacyZoneData()).toThrow(
      'does not know America/Chicago (at 2026-01-15T12:00:00.000Z it gives unsupported zone, not -360 minutes)',
    );
  });

  it('refuses zone data with other offsets', () => {
    const fromISO = DateTime.fromISO.bind(DateTime);
    jest.spyOn(DateTime, 'fromISO').mockImplementation((text) => fromISO(text, { zone: 'UTC-6' }));

    expect(() => assertLegacyZoneData()).toThrow('at 2026-03-08T08:00:00.000Z it gives -360, not -300 minutes');
  });
});
