import { BadRequestException } from '@nestjs/common';

import { resolveStatisticsPeriod } from './statistics-period';
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
