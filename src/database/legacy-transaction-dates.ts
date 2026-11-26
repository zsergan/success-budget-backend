import { DateTime } from 'luxon';

// The history before ReplaceTransactionTimestampWithDate1791500000000 was
// entered in Chicago: each stored instant becomes the calendar day it had
// there, under that zone's DST rules of the day itself.
export const LEGACY_TIME_ZONE = 'America/Chicago';

// Offsets in minutes at instants on both sides of DST changes, the rules
// before 2007 included. A Node without full zone data fails here, before
// anything is written.
const KNOWN_OFFSETS: ReadonlyArray<readonly [string, number]> = [
  ['2026-01-15T12:00:00.000Z', -360],
  ['2026-03-08T07:59:59.999Z', -360],
  ['2026-03-08T08:00:00.000Z', -300],
  ['2026-11-01T06:59:59.999Z', -300],
  ['2026-11-01T07:00:00.000Z', -360],
  ['2006-04-02T07:59:59.999Z', -360],
  ['2006-04-02T08:00:00.000Z', -300],
  ['2006-10-29T06:59:59.999Z', -300],
  ['2006-10-29T07:00:00.000Z', -360],
];

export function assertLegacyZoneData(): void {
  for (const [instant, expected] of KNOWN_OFFSETS) {
    const local = DateTime.fromISO(instant, { zone: LEGACY_TIME_ZONE });

    if (!local.isValid || local.offset !== expected) {
      throw new Error(
        `The time zone data of this Node does not know ${LEGACY_TIME_ZONE} (at ${instant} it gives ` +
          `${local.isValid ? local.offset : local.invalidReason}, not ${expected} minutes); nothing was changed.`,
      );
    }
  }
}

// YYYY-MM-DD of the instant in Chicago
export function legacyDateOf(epochMs: number): string {
  const local = DateTime.fromMillis(epochMs, { zone: LEGACY_TIME_ZONE });

  if (!local.isValid) {
    throw new RangeError(`Not an instant: ${epochMs}`);
  }

  return local.toISODate();
}

// The first millisecond of the Chicago day, as epoch milliseconds
export function legacyDayStart(date: string): number {
  const local = DateTime.fromISO(date, { zone: LEGACY_TIME_ZONE });

  if (!local.isValid) {
    throw new RangeError(`Not a calendar date: ${date}`);
  }

  return local.startOf('day').toMillis();
}

export const nextDate = (date: string): string =>
  DateTime.fromISO(date, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;
