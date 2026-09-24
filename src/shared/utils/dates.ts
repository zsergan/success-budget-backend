import { isISO8601 } from 'class-validator';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const getStartOfMonth = (date: Date) => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

export const getEndOfMonth = (date: Date) => {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
};

// Date-only and offset-less values are local time, matching how TypeORM
// parses strings for timestamp columns; Z/offset values are exact instants.
export const parseIsoDate = (value: string): Date | null => {
  if (!isISO8601(value, { strict: true })) {
    return null;
  }

  const dateOnly = DATE_ONLY.exec(value);

  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }

  if (!DATE_TIME.test(value)) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
};

export const toDate = (value: string): Date => {
  const date = parseIsoDate(value);

  if (!date) {
    throw new TypeError(`Not a valid ISO 8601 date: ${value}`);
  }

  return date;
};
