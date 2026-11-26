import { BadRequestException } from '@nestjs/common';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import {
  type CalendarDate,
  type CalendarUnit,
  type DateRange,
  FIRST_DATE,
  LAST_DATE,
  type TimeState,
  calendarDateAt,
  daysIn,
  earlier,
  formatCalendarDate,
  parseCalendarDate,
  rangeOf,
  shift,
  splitRange,
  timeState,
  unitKey,
} from './statistics-calendar';
import { StatisticsPeriodType } from '@shared/enums';
import { MAX_CALENDAR_DATE, MIN_CALENDAR_DATE, resolveTimeZone } from '@shared/utils';
import { CLOCK_SKEW_MS } from '@shared/constants';

export const MAX_CUSTOM_PERIOD_DAYS = 366;
export const MAX_DAILY_CUSTOM_DAYS = 14;
export const MAX_WEEKLY_CUSTOM_DAYS = 92;
export const AS_OF_CLOCK_SKEW_MS = CLOCK_SKEW_MS;

export type TrendGranularity = 'day' | 'week' | 'month';

interface Dates {
  start_date: string;
  end_date: string;
}

export interface StatisticsPeriod extends Dates {
  type: StatisticsPeriodType;
  time_zone: string;
  as_of: Date;
  // min(end_date, today); null while the period has not started
  actual_end_date: string | null;
  state: TimeState;
}

export interface PreviousPeriod extends Dates {
  // the like-for-like cut of a current period, otherwise end_date
  actual_end_date: string;
}

export interface TrendInterval extends Dates {
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

const datesOf = (range: DateRange): Dates => ({
  start_date: formatCalendarDate(range.start),
  end_date: formatCalendarDate(range.end),
});

const rangeOfPeriod = (period: StatisticsPeriod): DateRange => ({
  start: parseCalendarDate(period.start_date),
  end: parseCalendarDate(period.end_date),
});

// The date of as_of in the period's zone: the last day a current period counts.
export const todayOf = (period: StatisticsPeriod): CalendarDate => calendarDateAt(period.as_of, period.time_zone);

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
// combine and turns them into the period's dates.
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

  const today = calendarDateAt(asOf, timeZone);
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
    const anchor = query.anchor_date === undefined ? today : parseCalendarDate(query.anchor_date);
    range = rangeOf(STANDARD_UNIT[query.period], anchor);
    rangeField = 'anchor_date';
  }

  if (range.start < FIRST_DATE || range.end > LAST_DATE) {
    fail([{ field: rangeField, error: `the period must be within ${MIN_CALENDAR_DATE} and ${MAX_CALENDAR_DATE}` }]);
  }

  const state = timeState(range, today);

  return {
    type: query.period,
    time_zone: timeZone,
    ...datesOf(range),
    as_of: asOf,
    actual_end_date: state === 'future' ? null : formatCalendarDate(earlier(range.end, today)),
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

export const resolveTrendIntervals = (period: StatisticsPeriod, granularity: TrendGranularity): TrendInterval[] => {
  const today = todayOf(period);

  return splitRange(rangeOfPeriod(period), granularity).map((range) => ({
    key: unitKey(range.start, granularity),
    ...datesOf(range),
    state: timeState(range, today),
  }));
};

// A finished period is compared with the whole previous one, a current
// period with the previous one up to the equivalent day of today, that day
// included; custom and future periods are not compared.
export const resolvePreviousPeriod = (period: StatisticsPeriod): PreviousPeriod | null => {
  if (period.type === StatisticsPeriodType.CUSTOM || period.state === 'future') {
    return null;
  }

  const unit = STANDARD_UNIT[period.type];
  const range = rangeOf(unit, shift(rangeOfPeriod(period).start, unit, -1));
  const actualEnd = period.state === 'past' ? range.end : earlier(shift(todayOf(period), unit, -1), range.end);

  return { ...datesOf(range), actual_end_date: formatCalendarDate(actualEnd) };
};
