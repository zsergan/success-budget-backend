// A calendar date without a time zone, as whole days since 1970-01-01.
export type LocalDay = number;

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_OFFSET = /^[+-]/;

const formatters = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    formatters.set(timeZone, formatter);
  }

  return formatter;
};

// Canonical IANA name, or null. Fixed offsets are rejected: they ignore DST.
export const resolveTimeZone = (value: string): string | null => {
  if (UTC_OFFSET.test(value)) {
    return null;
  }

  try {
    return getFormatter(value).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

export const toLocalDay = (year: number, month: number, day: number): LocalDay =>
  Date.UTC(year, month - 1, day) / DAY_MS;

export const parseLocalDate = (value: string): LocalDay | null => {
  const match = LOCAL_DATE.exec(value);

  if (!match) {
    return null;
  }

  const day = toLocalDay(Number(match[1]), Number(match[2]), Number(match[3]));

  return formatLocalDate(day) === value ? day : null;
};

export const formatLocalDate = (day: LocalDay): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export const localDateParts = (day: LocalDay) => {
  const date = new Date(day * DAY_MS);

  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

// 0 = Monday ... 6 = Sunday; 1970-01-01 was a Thursday.
export const isoWeekday = (day: LocalDay): number => (((day + 3) % 7) + 7) % 7;

export const localDayAt = (instant: Date, timeZone: string): LocalDay => {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);

  return toLocalDay(part('year'), part('month'), part('day'));
};

// First instant whose local date is `day`: midnight, or the end of a DST gap
// that swallows it. Found by bisection instead of offset arithmetic, since
// the offset itself changes around the instant being looked for.
export const startOfLocalDay = (day: LocalDay, timeZone: string): Date => {
  // UTC offsets stay within -12h..+14h
  let before = day * DAY_MS - 15 * 3_600_000;
  let atOrAfter = day * DAY_MS + 13 * 3_600_000;

  while (atOrAfter - before > 1) {
    const middle = Math.floor((before + atOrAfter) / 2);

    if (localDayAt(new Date(middle), timeZone) >= day) {
      atOrAfter = middle;
    } else {
      before = middle;
    }
  }

  return new Date(atOrAfter);
};

export const endOfLocalDay = (day: LocalDay, timeZone: string): Date =>
  new Date(startOfLocalDay(day + 1, timeZone).getTime() - 1);
