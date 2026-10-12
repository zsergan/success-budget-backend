import { BadRequestException } from '@nestjs/common';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import {
  type CalendarUnit,
  type DateRange,
  type TimeState,
  calendarDateAt,
  daysIn,
  endOfDay,
  formatCalendarDate,
  parseCalendarDate,
  rangeOf,
  shift,
  shiftInstant,
  splitRange,
  startOfDay,
  timeState,
  unitKey,
} from './statistics-calendar';
import { StatisticsPeriodType } from '@shared/enums';
import { TIMESTAMP_MAX, TIMESTAMP_MIN } from '@shared/decorators/is-iso-date.decorator';
import { resolveTimeZone } from '@shared/utils';
import { CLOCK_SKEW_MS } from '@shared/constants';

export const MAX_CUSTOM_PERIOD_DAYS = 366;
export const MAX_DAILY_CUSTOM_DAYS = 14;
export const MAX_WEEKLY_CUSTOM_DAYS = 92;
export const AS_OF_CLOCK_SKEW_MS = CLOCK_SKEW_MS;

export type TrendGranularity = 'day' | 'week' | 'month';

interface Bounds {
  start_date: string;
  end_date: string;
  from: Date;
  to: Date;
}

export interface StatisticsPeriod extends Bounds {
  type: StatisticsPeriodType;
  time_zone: string;
  as_of: Date;
  // min(to, as_of); null while the period has not started
  actual_to: Date | null;
  state: TimeState;
}

export interface PreviousPeriod extends Bounds {
  // the like-for-like cut of a current period, otherwise to
  actual_to: Date;
}

export interface TrendInterval extends Bounds {
  key: string;
  state: TimeState;
}

const STANDARD_UNIT: Record<Exclude<StatisticsPeriodType, StatisticsPeriodType.CUSTOM>, CalendarUnit> = {
  [StatisticsPeriodType.WEEK]: 'week',
  [StatisticsPeriodType.MONTH]: 'month',
  [StatisticsPeriodType.YEAR]: 'year',
};

const TREND_GRANULARITY: Record<Exclude<StatisticsPeriodType, StatisticsPeriodType.CUSTOM>, TrendGranularity> = {
  [StatisticsPeriodType.WEEK]: 'day',
  [StatisticsPeriodType.MONTH]: 'week',
  [StatisticsPeriodType.YEAR]: 'month',
};

const boundsOf = (range: DateRange, timeZone: string): Bounds => ({
  start_date: formatCalendarDate(range.start),
  end_date: formatCalendarDate(range.end),
  from: startOfDay(range.start, timeZone),
  to: endOfDay(range.end, timeZone),
});

const rangeOfPeriod = (period: StatisticsPeriod): DateRange => ({
  start: parseCalendarDate(period.start_date),
  end: parseCalendarDate(period.end_date),
});

interface FieldError {
  field: string;
  error: string;
}

const fail = (errors: FieldError[]): never => {
  throw new BadRequestException(errors);
};

const checkPeriodFields = (query: StatisticsQueryDto): FieldError[] => {
  const errors: FieldError[] = [];

  if (query.period === StatisticsPeriodType.CUSTOM) {
    if (query.anchor_date !== undefined) {
      errors.push({ field: 'anchor_date', error: 'anchor_date must not be set for a custom period' });
    }

    for (const field of ['from_date', 'to_date'] as const) {
      if (query[field] === undefined) {
        errors.push({ field, error: `${field} is required for a custom period` });
      }
    }
  } else {
    for (const field of ['from_date', 'to_date'] as const) {
      if (query[field] !== undefined) {
        errors.push({ field, error: `${field} must be set only for a custom period` });
      }
    }
  }

  return errors;
};

// The DTO has already validated each field on its own; this checks how they
// combine and turns them into instants.
export const resolveStatisticsPeriod = (query: StatisticsQueryDto, serverNow: Date): StatisticsPeriod => {
  const errors = checkPeriodFields(query);
  const timeZone = resolveTimeZone(query.time_zone)!;
  const asOf = query.as_of === undefined ? serverNow : new Date(query.as_of);

  if (asOf.getTime() > serverNow.getTime() + AS_OF_CLOCK_SKEW_MS) {
    errors.push({ field: 'as_of', error: 'as_of must not be in the future' });
  }

  if (errors.length) {
    fail(errors);
  }

  let range: DateRange;
  let rangeField: 'anchor_date' | 'to_date';

  if (query.period === StatisticsPeriodType.CUSTOM) {
    range = { start: parseCalendarDate(query.from_date!), end: parseCalendarDate(query.to_date!) };
    rangeField = 'to_date';

    if (range.start > range.end) {
      fail([{ field: 'to_date', error: 'to_date must not be before from_date' }]);
    }

    if (daysIn(range) > MAX_CUSTOM_PERIOD_DAYS) {
      fail([{ field: 'to_date', error: `a custom period must not exceed ${MAX_CUSTOM_PERIOD_DAYS} days` }]);
    }
  } else {
    const anchor =
      query.anchor_date === undefined ? calendarDateAt(asOf, timeZone) : parseCalendarDate(query.anchor_date);
    range = rangeOf(STANDARD_UNIT[query.period], anchor);
    rangeField = 'anchor_date';
  }

  const bounds = boundsOf(range, timeZone);

  if (bounds.from < TIMESTAMP_MIN || bounds.to > TIMESTAMP_MAX) {
    fail([
      {
        field: rangeField,
        error: `the period must be within ${TIMESTAMP_MIN.toISOString()} and ${TIMESTAMP_MAX.toISOString()}`,
      },
    ]);
  }

  const state = timeState(bounds.from, bounds.to, asOf);

  return {
    type: query.period,
    time_zone: timeZone,
    ...bounds,
    as_of: asOf,
    actual_to: state === 'future' ? null : state === 'past' ? bounds.to : asOf,
    state,
  };
};

export const trendGranularity = (period: StatisticsPeriod): TrendGranularity => {
  if (period.type !== StatisticsPeriodType.CUSTOM) {
    return TREND_GRANULARITY[period.type];
  }

  const days = daysIn(rangeOfPeriod(period));

  return days <= MAX_DAILY_CUSTOM_DAYS ? 'day' : days <= MAX_WEEKLY_CUSTOM_DAYS ? 'week' : 'month';
};

export const resolveTrendIntervals = (period: StatisticsPeriod, granularity: TrendGranularity): TrendInterval[] =>
  splitRange(rangeOfPeriod(period), granularity).map((range) => {
    const bounds = boundsOf(range, period.time_zone);

    return {
      key: unitKey(range.start, granularity),
      ...bounds,
      state: timeState(bounds.from, bounds.to, period.as_of),
    };
  });

// A finished period is compared with the whole previous one, a current
// period with the same elapsed part of it; custom and future periods are not
// compared.
export const resolvePreviousPeriod = (period: StatisticsPeriod): PreviousPeriod | null => {
  if (period.type === StatisticsPeriodType.CUSTOM || period.state === 'future') {
    return null;
  }

  const unit = STANDARD_UNIT[period.type];
  const bounds = boundsOf(rangeOf(unit, shift(rangeOfPeriod(period).start, unit, -1)), period.time_zone);
  const actualTo = period.state === 'past' ? bounds.to : shiftInstant(period.as_of, period.time_zone, unit, -1);

  return { ...bounds, actual_to: actualTo < bounds.to ? actualTo : bounds.to };
};
