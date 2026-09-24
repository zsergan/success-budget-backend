const MONEY_INPUT = /^(\d+)(?:\.(\d{1,2}))?$/;
const MONEY_VALUE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export const MAX_MONEY_INPUT = '99999999.99';
export const MAX_MONEY_INPUT_CENTS = 9_999_999_999n;

const toCents = (integer: string, fraction = '') => BigInt(integer + fraction.padEnd(2, '0'));

const floorDiv = (dividend: bigint, divisor: bigint) => {
  const quotient = dividend / divisor;

  return dividend % divisor !== 0n && dividend < 0n !== divisor < 0n ? quotient - 1n : quotient;
};

export const isMoneyInputFormat = (value: unknown): value is string =>
  typeof value === 'string' && MONEY_INPUT.test(value);

// A request amount: unsigned, at most two decimal places, within DECIMAL(10,2).
export const parseMoneyInput = (value: string): bigint | null => {
  const match = MONEY_INPUT.exec(value);

  if (!match) {
    return null;
  }

  const cents = toCents(match[1], match[2]);

  return cents <= MAX_MONEY_INPUT_CENTS ? cents : null;
};

const matchMoney = (value: string): bigint | null => {
  const match = MONEY_VALUE.exec(value);

  if (!match) {
    return null;
  }

  const cents = toCents(match[2], match[3]);

  return match[1] ? -cents : cents;
};

// A stored or computed value (column, SQL SUM): may be negative and exceed a
// single amount's range.
export const parseMoney = (value: string): bigint => {
  const cents = matchMoney(value);

  if (cents === null) {
    throw new TypeError(`Not a money value: ${value}`);
  }

  return cents;
};

export const formatMoney = (cents: bigint): string => {
  const sign = cents < 0n ? '-' : '';
  const digits = (cents < 0n ? -cents : cents).toString().padStart(3, '0');

  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

// For the number-typed response fields; throws instead of dropping cents.
// Checked against the JSON form, which can be shorter than toFixed(2) shows.
export const moneyToNumber = (cents: bigint): number => {
  const value = Number(formatMoney(cents));

  if (matchMoney(JSON.stringify(value)) !== cents) {
    throw new RangeError(`Money value cannot be represented as a number: ${formatMoney(cents)}`);
  }

  return value;
};

export const floorPercent = (part: bigint, whole: bigint): number =>
  whole === 0n ? 0 : Number(floorDiv(part * 100n, whole));

// One decimal place, halves toward positive infinity (as Math.round).
export const roundPercentToTenth = (part: bigint, whole: bigint): number => {
  if (whole === 0n) {
    return 0;
  }

  const tenths = floorDiv(part * 2000n + whole, whole * 2n);

  return Number(tenths) / 10;
};
