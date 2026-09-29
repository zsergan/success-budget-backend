import { BadRequestException } from '@nestjs/common';

import type { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsPeriodType } from '@shared/enums';
import { TIMESTAMP_MAX, TIMESTAMP_MIN } from '@shared/decorators/is-iso-date.decorator';
import {
  type LocalDay,
  endOfLocalDay,
  formatLocalDate,
  isoWeekday,
  localDateParts,
  localDayAt,
  parseLocalDate,
  resolveTimeZone,
  startOfLocalDay,
  toLocalDay,
} from '@shared/utils';

export const MAX_CUSTOM_PERIOD_DAYS = 366;
// device clocks drift; a slightly early server must not reject the client's now
export const AS_OF_CLOCK_SKEW_MS = 60_000;

export type StatisticsPeriodState = 'past' | 'current' | 'future';

export interface StatisticsPeriod {
  type: StatisticsPeriodType;
  time_zone: string;
  start_date: string;
  end_date: string;
  from: Date;
  to: Date;
  as_of: Date;
  // min(to, as_of); null while the period has not started
  actual_to: Date | null;
  state: StatisticsPeriodState;
}

const localRange = (type: StatisticsPeriodType, anchor: LocalDay): [LocalDay, LocalDay] => {
  const { year, month } = localDateParts(anchor);

  switch (type) {
    case StatisticsPeriodType.WEEK: {
      const monday = anchor - isoWeekday(anchor);

      return [monday, monday + 6];
    }
    case StatisticsPeriodType.MONTH:
      return [toLocalDay(year, month, 1), toLocalDay(year, month + 1, 0)];
    default:
      return [toLocalDay(year, 1, 1), toLocalDay(year, 12, 31)];
  }
};

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

  let startDay: LocalDay;
  let endDay: LocalDay;
  let rangeField: 'anchor_date' | 'to_date';

  if (query.period === StatisticsPeriodType.CUSTOM) {
    startDay = parseLocalDate(query.from_date!)!;
    endDay = parseLocalDate(query.to_date!)!;
    rangeField = 'to_date';

    if (startDay > endDay) {
      fail([{ field: 'to_date', error: 'to_date must not be before from_date' }]);
    }

    if (endDay - startDay + 1 > MAX_CUSTOM_PERIOD_DAYS) {
      fail([{ field: 'to_date', error: `a custom period must not exceed ${MAX_CUSTOM_PERIOD_DAYS} days` }]);
    }
  } else {
    const anchor = query.anchor_date === undefined ? localDayAt(asOf, timeZone) : parseLocalDate(query.anchor_date)!;
    [startDay, endDay] = localRange(query.period, anchor);
    rangeField = 'anchor_date';
  }

  const from = startOfLocalDay(startDay, timeZone);
  const to = endOfLocalDay(endDay, timeZone);

  if (from < TIMESTAMP_MIN || to > TIMESTAMP_MAX) {
    fail([
      {
        field: rangeField,
        error: `the period must be within ${TIMESTAMP_MIN.toISOString()} and ${TIMESTAMP_MAX.toISOString()}`,
      },
    ]);
  }

  const state: StatisticsPeriodState = asOf < from ? 'future' : asOf > to ? 'past' : 'current';

  return {
    type: query.period,
    time_zone: timeZone,
    start_date: formatLocalDate(startDay),
    end_date: formatLocalDate(endDay),
    from,
    to,
    as_of: asOf,
    actual_to: state === 'future' ? null : state === 'past' ? to : asOf,
    state,
  };
};
