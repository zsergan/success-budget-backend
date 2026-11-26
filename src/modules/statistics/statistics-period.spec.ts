import { BadRequestException } from '@nestjs/common';

import {
  resolvePreviousPeriod,
  resolveStatisticsPeriod,
  resolveTrendIntervals,
  trendGranularity,
} from './statistics-period';
import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsPeriodType } from '@shared/enums';

// 15:00 on Monday 2026-09-28 in Moscow
const NOW = new Date('2026-09-28T12:00:00.000Z');

const query = (overrides: Partial<StatisticsQueryDto> = {}): StatisticsQueryDto => ({
  period: StatisticsPeriodType.MONTH,
  time_zone: 'Europe/Moscow',
  ...overrides,
});

const resolve = (overrides: Partial<StatisticsQueryDto> = {}, now = NOW) =>
  JSON.parse(JSON.stringify(resolveStatisticsPeriod(query(overrides), now)));

const errorsOf = (overrides: Partial<StatisticsQueryDto>, now = NOW) => {
  try {
    resolveStatisticsPeriod(query(overrides), now);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);

    return (error as BadRequestException).getResponse();
  }

  throw new Error('expected a 400');
};

describe('resolveStatisticsPeriod', () => {
  it('resolves the current month, ending with the date of as_of in the zone', () => {
    expect(resolve()).toEqual({
      type: 'month',
      time_zone: 'Europe/Moscow',
      start_date: '2026-09-01',
      end_date: '2026-09-30',
      as_of: '2026-09-28T12:00:00.000Z',
      actual_end_date: '2026-09-28',
      state: 'current',
    });
  });

  it('takes today from as_of in the zone, not in UTC', () => {
    const period = resolve({ period: StatisticsPeriodType.WEEK, as_of: '2026-09-27T21:30:00.000Z' });

    expect(period).toMatchObject({
      start_date: '2026-09-28',
      end_date: '2026-10-04',
      as_of: '2026-09-27T21:30:00.000Z',
      actual_end_date: '2026-09-28',
      state: 'current',
    });
    expect(
      resolve({ period: StatisticsPeriodType.WEEK, as_of: '2026-09-27T21:30:00.000Z', time_zone: 'UTC' }),
    ).toMatchObject({ start_date: '2026-09-21', end_date: '2026-09-27', actual_end_date: '2026-09-27' });
  });

  it('makes a period current on its first day and past only after its last day', () => {
    const firstDay = resolve({}, new Date('2026-08-31T21:00:00.000Z'));
    const lastMoment = resolve({ anchor_date: '2026-09-15' }, new Date('2026-09-30T20:59:59.999Z'));
    const nextDay = resolve({ anchor_date: '2026-09-15' }, new Date('2026-09-30T21:00:00.000Z'));

    expect(firstDay).toMatchObject({ start_date: '2026-09-01', state: 'current', actual_end_date: '2026-09-01' });
    expect(lastMoment).toMatchObject({ state: 'current', actual_end_date: '2026-09-30' });
    expect(nextDay).toMatchObject({ state: 'past', actual_end_date: '2026-09-30' });
  });

  it.each([
    [StatisticsPeriodType.WEEK, '2026-10-01', '2026-09-28', '2026-10-04'],
    [StatisticsPeriodType.WEEK, '2027-01-01', '2026-12-28', '2027-01-03'],
    [StatisticsPeriodType.MONTH, '2028-02-10', '2028-02-01', '2028-02-29'],
    [StatisticsPeriodType.MONTH, '2026-12-31', '2026-12-01', '2026-12-31'],
    [StatisticsPeriodType.YEAR, '2025-06-15', '2025-01-01', '2025-12-31'],
  ])('%s containing %s is %s..%s', (period, anchor, start, end) => {
    expect(resolve({ period, anchor_date: anchor })).toMatchObject({ start_date: start, end_date: end });
  });

  it('marks a finished period past and a coming one future', () => {
    expect(resolve({ anchor_date: '2026-08-15' })).toMatchObject({ state: 'past', actual_end_date: '2026-08-31' });
    expect(resolve({ anchor_date: '2026-10-15' })).toMatchObject({ state: 'future', actual_end_date: null });
  });

  it('resolves a custom period with inclusive dates', () => {
    expect(
      resolve({ period: StatisticsPeriodType.CUSTOM, from_date: '2026-09-10', to_date: '2026-09-20' }),
    ).toMatchObject({
      start_date: '2026-09-10',
      end_date: '2026-09-20',
      actual_end_date: '2026-09-20',
      state: 'past',
    });
  });

  it('gives a period the same dates in every zone, across DST', () => {
    const berlin = resolve({
      period: StatisticsPeriodType.WEEK,
      anchor_date: '2026-10-25',
      time_zone: 'Europe/Berlin',
    });
    const tokyo = resolve({ period: StatisticsPeriodType.WEEK, anchor_date: '2026-10-25', time_zone: 'Asia/Tokyo' });

    expect(berlin).toMatchObject({ start_date: '2026-10-19', end_date: '2026-10-25', state: 'future' });
    expect(tokyo).toMatchObject({ start_date: '2026-10-19', end_date: '2026-10-25', state: 'future' });
  });

  it('reports the canonical zone name', () => {
    expect(resolve({ time_zone: 'europe/moscow' }).time_zone).toBe('Europe/Moscow');
  });

  describe('as_of', () => {
    it('accepts a value within the allowed clock skew and keeps it as sent', () => {
      expect(resolve({ as_of: '2026-09-28T12:00:59.000Z' }).as_of).toBe('2026-09-28T12:00:59.000Z');
    });

    it('rejects a value in the future', () => {
      expect(errorsOf({ as_of: '2026-09-28T12:01:01.000Z' })).toEqual({
        statusCode: 400,
        message: [{ field: 'as_of', error: 'as_of must not be in the future' }],
        error: 'Bad Request',
      });
    });
  });

  describe('field combinations', () => {
    const messages = (overrides: Partial<StatisticsQueryDto>) =>
      (errorsOf(overrides) as { message: { field: string; error: string }[] }).message;

    it('requires both custom dates and forbids anchor_date there', () => {
      expect(messages({ period: StatisticsPeriodType.CUSTOM, anchor_date: '2026-09-01' })).toEqual([
        { field: 'anchor_date', error: 'anchor_date must not be set for a custom period' },
        { field: 'from_date', error: 'from_date is required for a custom period' },
        { field: 'to_date', error: 'to_date is required for a custom period' },
      ]);
    });

    it('forbids custom dates on a standard period', () => {
      expect(messages({ from_date: '2026-09-01' })).toEqual([
        { field: 'from_date', error: 'from_date must be set only for a custom period' },
      ]);
    });

    it('rejects a reversed range', () => {
      expect(messages({ period: StatisticsPeriodType.CUSTOM, from_date: '2026-09-20', to_date: '2026-09-10' })).toEqual(
        [{ field: 'to_date', error: 'to_date must not be before from_date' }],
      );
    });

    it('allows 366 days and rejects 367', () => {
      expect(
        resolve({ period: StatisticsPeriodType.CUSTOM, from_date: '2027-01-01', to_date: '2028-01-01' }).end_date,
      ).toBe('2028-01-01');
      expect(messages({ period: StatisticsPeriodType.CUSTOM, from_date: '2027-01-01', to_date: '2028-01-02' })).toEqual(
        [{ field: 'to_date', error: 'a custom period must not exceed 366 days' }],
      );
    });

    it('takes periods TIMESTAMP could not hold, within the DATE range', () => {
      expect(resolve({ period: StatisticsPeriodType.YEAR, anchor_date: '2040-06-01' })).toMatchObject({
        start_date: '2040-01-01',
        end_date: '2040-12-31',
        state: 'future',
      });
      expect(resolve({ anchor_date: '1969-12-31', time_zone: 'Asia/Tokyo' })).toMatchObject({
        start_date: '1969-12-01',
        actual_end_date: '1969-12-31',
        state: 'past',
      });
      expect(resolve({ period: StatisticsPeriodType.YEAR, anchor_date: '9999-03-01' }).end_date).toBe('9999-12-31');
    });

    it('rejects a period reaching outside the DATE range', () => {
      const error = { error: 'the period must be within 1000-01-01 and 9999-12-31' };

      expect(messages({ period: StatisticsPeriodType.WEEK, anchor_date: '9999-12-31' })).toEqual([
        { field: 'anchor_date', ...error },
      ]);
      expect(messages({ period: StatisticsPeriodType.WEEK, anchor_date: '1000-01-01' })).toEqual([
        { field: 'anchor_date', ...error },
      ]);
    });
  });
});

describe('trend intervals', () => {
  const trend = (overrides: Partial<StatisticsQueryDto>, now = NOW) => {
    const period = resolveStatisticsPeriod(query(overrides), now);
    const granularity = trendGranularity(period);

    return { granularity, intervals: JSON.parse(JSON.stringify(resolveTrendIntervals(period, granularity))) };
  };
  const custom = (from_date: string, to_date: string) => ({ period: StatisticsPeriodType.CUSTOM, from_date, to_date });

  it('splits the current month into clipped weeks with past, current and future states', () => {
    const { granularity, intervals } = trend({});

    expect(granularity).toBe('week');
    expect(intervals).toEqual([
      { key: '2026-W36', start_date: '2026-09-01', end_date: '2026-09-06', state: 'past' },
      expect.objectContaining({ key: '2026-W37', start_date: '2026-09-07', end_date: '2026-09-13', state: 'past' }),
      expect.objectContaining({ key: '2026-W38', state: 'past' }),
      expect.objectContaining({ key: '2026-W39', state: 'past' }),
      { key: '2026-W40', start_date: '2026-09-28', end_date: '2026-09-30', state: 'current' },
    ]);
  });

  it.each([
    // starts on a Monday, 28 days
    ['2027-02-10', 4],
    ['2026-09-10', 5],
    // starts on a Sunday, ends on a Tuesday
    ['2027-08-10', 6],
  ])('gives the month of %s %i weeks', (anchor, count) => {
    const { granularity, intervals } = trend({ anchor_date: anchor }, new Date('2028-01-01T00:00:00.000Z'));

    expect(granularity).toBe('week');
    expect(intervals).toHaveLength(count);
    expect(intervals[0].start_date.slice(0, 7)).toBe(anchor.slice(0, 7));
    expect(intervals[count - 1].end_date.slice(0, 7)).toBe(anchor.slice(0, 7));
  });

  it('gives a week its seven days, the rest of them future', () => {
    const { granularity, intervals } = trend({ period: StatisticsPeriodType.WEEK });

    expect(granularity).toBe('day');
    expect(intervals.map((i: { key: string; state: string }) => `${i.key} ${i.state}`)).toEqual([
      '2026-09-28 current',
      '2026-09-29 future',
      '2026-09-30 future',
      '2026-10-01 future',
      '2026-10-02 future',
      '2026-10-03 future',
      '2026-10-04 future',
    ]);
  });

  it('gives a year its twelve months', () => {
    const { granularity, intervals } = trend({ period: StatisticsPeriodType.YEAR, anchor_date: '2028-01-01' });

    expect(granularity).toBe('month');
    expect(intervals).toHaveLength(12);
    expect(intervals[1]).toMatchObject({ key: '2028-02', start_date: '2028-02-01', end_date: '2028-02-29' });
    expect(intervals.every((i: { state: string }) => i.state === 'future')).toBe(true);
  });

  it.each([
    ['2026-09-01', '2026-09-14', 'day', 14],
    ['2026-09-01', '2026-09-15', 'week', 3],
    ['2026-06-01', '2026-08-31', 'week', 14],
    ['2026-06-01', '2026-09-01', 'month', 4],
    ['2025-09-28', '2026-09-28', 'month', 13],
  ])('custom %s..%s is split by %s into %i', (from, to, granularity, count) => {
    const result = trend(custom(from, to));

    expect(result.granularity).toBe(granularity);
    expect(result.intervals).toHaveLength(count);
  });

  it('clips the first and the last custom interval to the range', () => {
    const { intervals } = trend(custom('2026-09-03', '2026-09-22'));

    expect(intervals.map((i: { start_date: string; end_date: string }) => `${i.start_date}..${i.end_date}`)).toEqual([
      '2026-09-03..2026-09-06',
      '2026-09-07..2026-09-13',
      '2026-09-14..2026-09-20',
      '2026-09-21..2026-09-22',
    ]);
  });

  it('gives a DST day one bucket like any other day', () => {
    const { intervals } = trend(
      { period: StatisticsPeriodType.WEEK, anchor_date: '2026-10-25', time_zone: 'Europe/Berlin' },
      new Date('2026-10-25T12:00:00.000Z'),
    );

    expect(intervals[6]).toEqual({
      key: '2026-10-25',
      start_date: '2026-10-25',
      end_date: '2026-10-25',
      state: 'current',
    });
    expect(intervals[5]).toMatchObject({ key: '2026-10-24', state: 'past' });
  });
});

describe('resolvePreviousPeriod', () => {
  const previous = (overrides: Partial<StatisticsQueryDto>, now = NOW) =>
    JSON.parse(JSON.stringify(resolvePreviousPeriod(resolveStatisticsPeriod(query(overrides), now))));

  it('cuts the previous month at the equivalent day of a current month, that day included', () => {
    expect(previous({})).toEqual({ start_date: '2026-08-01', end_date: '2026-08-31', actual_end_date: '2026-08-28' });
  });

  it('takes the whole previous period for a finished one', () => {
    expect(previous({ anchor_date: '2026-03-10' })).toEqual({
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      actual_end_date: '2026-02-28',
    });
  });

  it.each([
    ['2026-03-31T10:00:00.000Z', '2026-02-01', '2026-02-28'],
    ['2026-10-31T10:00:00.000Z', '2026-09-01', '2026-09-30'],
    ['2028-03-30T10:00:00.000Z', '2028-02-01', '2028-02-29'],
  ])('clamps a missing day to the end of the shorter month on %s', (now, start, end) => {
    expect(previous({ time_zone: 'UTC' }, new Date(now))).toMatchObject({ start_date: start, actual_end_date: end });
  });

  it('compares a week with the week before and a year across the leap day', () => {
    expect(previous({ period: StatisticsPeriodType.WEEK })).toEqual({
      start_date: '2026-09-21',
      end_date: '2026-09-27',
      actual_end_date: '2026-09-21',
    });
    expect(
      previous({ period: StatisticsPeriodType.YEAR, time_zone: 'UTC' }, new Date('2028-02-29T10:00:00.000Z')),
    ).toEqual({ start_date: '2027-01-01', end_date: '2027-12-31', actual_end_date: '2027-02-28' });
  });

  it('compares the first week of a year with the last week of the previous one', () => {
    expect(
      previous({ period: StatisticsPeriodType.WEEK, anchor_date: '2027-01-01' }, new Date('2027-01-10T12:00:00.000Z')),
    ).toEqual({ start_date: '2026-12-21', end_date: '2026-12-27', actual_end_date: '2026-12-27' });
  });

  it('compares by days across a DST change and a year boundary', () => {
    expect(
      previous({ period: StatisticsPeriodType.WEEK, time_zone: 'Europe/Berlin' }, new Date('2026-10-26T11:00:00.000Z')),
    ).toMatchObject({ start_date: '2026-10-19', actual_end_date: '2026-10-19' });
    expect(
      previous({ period: StatisticsPeriodType.MONTH, time_zone: 'UTC' }, new Date('2027-01-05T00:00:00.000Z')),
    ).toEqual({ start_date: '2026-12-01', end_date: '2026-12-31', actual_end_date: '2026-12-05' });
  });

  it('does not compare a custom or a future period', () => {
    expect(
      previous({ period: StatisticsPeriodType.CUSTOM, from_date: '2026-08-01', to_date: '2026-08-31' }),
    ).toBeNull();
    expect(previous({ anchor_date: '2026-10-01' })).toBeNull();
  });
});
