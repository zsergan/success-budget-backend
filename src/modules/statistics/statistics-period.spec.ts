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
  it('resolves the current month in the given zone, cut at as_of', () => {
    expect(resolve()).toEqual({
      type: 'month',
      time_zone: 'Europe/Moscow',
      start_date: '2026-09-01',
      end_date: '2026-09-30',
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-30T20:59:59.999Z',
      as_of: '2026-09-28T12:00:00.000Z',
      actual_to: '2026-09-28T12:00:00.000Z',
      state: 'current',
    });
  });

  it('takes the anchor date from as_of in the zone, not in UTC', () => {
    const period = resolve({ period: StatisticsPeriodType.WEEK, as_of: '2026-09-27T21:30:00.000Z' });

    expect(period).toMatchObject({
      start_date: '2026-09-28',
      end_date: '2026-10-04',
      from: '2026-09-27T21:00:00.000Z',
      as_of: '2026-09-27T21:30:00.000Z',
      state: 'current',
    });
    expect(
      resolve({ period: StatisticsPeriodType.WEEK, as_of: '2026-09-27T21:30:00.000Z', time_zone: 'UTC' }),
    ).toMatchObject({ start_date: '2026-09-21', end_date: '2026-09-27' });
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
    expect(resolve({ anchor_date: '2026-08-15' })).toMatchObject({
      state: 'past',
      actual_to: '2026-08-31T20:59:59.999Z',
    });
    expect(resolve({ anchor_date: '2026-10-15' })).toMatchObject({ state: 'future', actual_to: null });
  });

  it('resolves a custom period with inclusive local dates', () => {
    expect(
      resolve({ period: StatisticsPeriodType.CUSTOM, from_date: '2026-09-10', to_date: '2026-09-20' }),
    ).toMatchObject({
      start_date: '2026-09-10',
      end_date: '2026-09-20',
      from: '2026-09-09T21:00:00.000Z',
      to: '2026-09-20T20:59:59.999Z',
      state: 'past',
    });
  });

  it('follows DST in the period bounds', () => {
    expect(
      resolve({ period: StatisticsPeriodType.WEEK, anchor_date: '2026-10-25', time_zone: 'Europe/Berlin' }),
    ).toMatchObject({ from: '2026-10-18T22:00:00.000Z', to: '2026-10-25T22:59:59.999Z' });
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

    it('rejects a period outside the TIMESTAMP range', () => {
      expect(messages({ period: StatisticsPeriodType.YEAR, anchor_date: '2038-01-01' })).toEqual([
        {
          field: 'anchor_date',
          error: 'the period must be within 1970-01-01T00:00:01.000Z and 2038-01-19T03:14:07.000Z',
        },
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
      {
        key: '2026-W36',
        start_date: '2026-09-01',
        end_date: '2026-09-06',
        from: '2026-08-31T21:00:00.000Z',
        to: '2026-09-06T20:59:59.999Z',
        state: 'past',
      },
      expect.objectContaining({ key: '2026-W37', start_date: '2026-09-07', end_date: '2026-09-13', state: 'past' }),
      expect.objectContaining({ key: '2026-W38', state: 'past' }),
      expect.objectContaining({ key: '2026-W39', state: 'past' }),
      {
        key: '2026-W40',
        start_date: '2026-09-28',
        end_date: '2026-09-30',
        from: '2026-09-27T21:00:00.000Z',
        to: '2026-09-30T20:59:59.999Z',
        state: 'current',
      },
    ]);
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

  it('keeps DST days whole', () => {
    const { intervals } = trend({
      period: StatisticsPeriodType.WEEK,
      anchor_date: '2026-10-25',
      time_zone: 'Europe/Berlin',
    });

    expect(intervals[6]).toMatchObject({
      start_date: '2026-10-25',
      from: '2026-10-24T22:00:00.000Z',
      to: '2026-10-25T22:59:59.999Z',
    });
    expect(intervals[5].to).toBe('2026-10-24T21:59:59.999Z');
  });
});

describe('resolvePreviousPeriod', () => {
  const previous = (overrides: Partial<StatisticsQueryDto>, now = NOW) =>
    JSON.parse(JSON.stringify(resolvePreviousPeriod(resolveStatisticsPeriod(query(overrides), now))));

  it('cuts the previous month at the same local moment for a current month', () => {
    expect(previous({})).toEqual({
      start_date: '2026-08-01',
      end_date: '2026-08-31',
      from: '2026-07-31T21:00:00.000Z',
      to: '2026-08-31T20:59:59.999Z',
      actual_to: '2026-08-28T12:00:00.000Z',
    });
  });

  it('takes the whole previous period for a finished one', () => {
    expect(previous({ anchor_date: '2026-03-10' })).toMatchObject({
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      actual_to: '2026-02-28T20:59:59.999Z',
    });
  });

  it('clamps a missing day to the end of the shorter month', () => {
    expect(previous({ time_zone: 'UTC' }, new Date('2026-03-31T10:00:00.000Z'))).toMatchObject({
      start_date: '2026-02-01',
      actual_to: '2026-02-28T10:00:00.000Z',
    });
  });

  it('compares a week with the week before and a year across the leap day', () => {
    expect(previous({ period: StatisticsPeriodType.WEEK })).toMatchObject({
      start_date: '2026-09-21',
      end_date: '2026-09-27',
      actual_to: '2026-09-21T12:00:00.000Z',
    });
    expect(
      previous({ period: StatisticsPeriodType.YEAR, time_zone: 'UTC' }, new Date('2028-02-29T10:00:00.000Z')),
    ).toMatchObject({ start_date: '2027-01-01', end_date: '2027-12-31', actual_to: '2027-02-28T10:00:00.000Z' });
  });

  it('compares the first week of a year with the last week of the previous one', () => {
    expect(
      previous({ period: StatisticsPeriodType.WEEK, anchor_date: '2027-01-01' }, new Date('2027-01-10T12:00:00.000Z')),
    ).toMatchObject({ start_date: '2026-12-21', end_date: '2026-12-27', actual_to: '2026-12-27T20:59:59.999Z' });
  });

  it('keeps the wall-clock time across a DST change', () => {
    // 12:00 in Berlin on Monday after DST ended, and 12:00 a week earlier
    expect(
      previous({ period: StatisticsPeriodType.WEEK, time_zone: 'Europe/Berlin' }, new Date('2026-10-26T11:00:00.000Z')),
    ).toMatchObject({ from: '2026-10-18T22:00:00.000Z', actual_to: '2026-10-19T10:00:00.000Z' });
  });

  it('does not compare a custom or a future period', () => {
    expect(
      previous({ period: StatisticsPeriodType.CUSTOM, from_date: '2026-08-01', to_date: '2026-08-31' }),
    ).toBeNull();
    expect(previous({ anchor_date: '2026-10-01' })).toBeNull();
  });
});
