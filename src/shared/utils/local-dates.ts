import { DateTime } from 'luxon';

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_OFFSET = /^[+-]/;

export const isLocalDate = (value: string): boolean =>
  LOCAL_DATE.test(value) && DateTime.fromISO(value, { zone: 'utc' }).isValid;

// Canonical IANA name, or null. Fixed offsets are rejected: they ignore DST.
export const resolveTimeZone = (value: string): string | null => {
  if (UTC_OFFSET.test(value)) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};
