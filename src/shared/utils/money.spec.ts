import {
  MAX_MONEY_INPUT,
  MAX_MONEY_INPUT_CENTS,
  floorPercent,
  formatMoney,
  moneyToNumber,
  parseMoney,
  parseMoneyInput,
  roundPercentToTenth,
} from './money';

describe('parseMoneyInput', () => {
  it.each([
    ['0', 0n],
    ['0.00', 0n],
    ['12', 1200n],
    ['12.3', 1230n],
    ['12.30', 1230n],
    ['0.01', 1n],
    ['0.29', 29n],
    ['1.10', 110n],
    ['007.50', 750n],
    [MAX_MONEY_INPUT, MAX_MONEY_INPUT_CENTS],
  ])('parses %p as %p cents', (value, cents) => {
    expect(parseMoneyInput(value)).toBe(cents);
  });

  it.each(['1.234', '1.230', '0.001', '-1', '-0', '+1', '.5', '5.', '1e2', ' 1', '1 ', '', '1,5', 'abc', '0x10'])(
    'rejects the malformed %p',
    (value) => {
      expect(parseMoneyInput(value)).toBeNull();
    },
  );

  it.each(['100000000', '100000000.00', '99999999.991', '999999999999999999999'])(
    'rejects %p above the range',
    (value) => {
      expect(parseMoneyInput(value)).toBeNull();
    },
  );
});

describe('parseMoney', () => {
  it.each([
    ['0.00', 0n],
    ['12.30', 1230n],
    ['-12.30', -1230n],
    ['-0.05', -5n],
    ['7', 700n],
    ['100000000.00', 10_000_000_000n],
    ['12345678901234567890.12', 1_234_567_890_123_456_789_012n],
  ])('parses %p as %p cents', (value, cents) => {
    expect(parseMoney(value)).toBe(cents);
  });

  it.each(['1.234', '+1', '.5', '', 'NaN', '1e2'])('throws on %p', (value) => {
    expect(() => parseMoney(value)).toThrow(TypeError);
  });
});

describe('formatMoney', () => {
  it.each([
    [0n, '0.00'],
    [1n, '0.01'],
    [10n, '0.10'],
    [1230n, '12.30'],
    [-5n, '-0.05'],
    [-1230n, '-12.30'],
    [MAX_MONEY_INPUT_CENTS, MAX_MONEY_INPUT],
    [1_234_567_890_123_456_789_012n, '12345678901234567890.12'],
  ])('formats %p cents as %p', (cents, value) => {
    expect(formatMoney(cents)).toBe(value);
  });

  it('round-trips through parseMoney', () => {
    for (const value of ['0.00', '0.29', '-3.07', '99999999.99', '123456789.10']) {
      expect(formatMoney(parseMoney(value))).toBe(value);
    }
  });
});

describe('moneyToNumber', () => {
  it('converts cents without float multiplication error', () => {
    expect(moneyToNumber(29n)).toBe(0.29);
    expect(moneyToNumber(-1230n)).toBe(-12.3);
    expect(moneyToNumber(parseMoney('0.10') + parseMoney('0.20'))).toBe(0.3);
  });

  it.each([
    ['0.00', '0'],
    ['-0.90', '-0.9'],
    ['99999999.99', '99999999.99'],
    ['-99999999.99', '-99999999.99'],
    ['199999999.98', '199999999.98'],
    ['9007199254740.99', '9007199254740.99'],
  ])('keeps every cent of %p in the serialized response', (value, serialized) => {
    expect(JSON.stringify({ amount: moneyToNumber(parseMoney(value)) })).toBe(`{"amount":${serialized}}`);
  });

  it.each(['90071992547409.91', '90071992547409.93', '9007199254740993.00', '123456789012345678.99'])(
    'throws when %p would lose cents',
    (value) => {
      expect(() => moneyToNumber(parseMoney(value))).toThrow(RangeError);
    },
  );
});

describe('floorPercent', () => {
  it.each([
    [2900n, 10000n, 29],
    [29n, 100n, 29],
    [57n, 100n, 57],
    [1n, 3n, 33],
    [2n, 3n, 66],
    [9999n, 10000n, 99],
    [10000n, 10000n, 100],
    [25000n, 10000n, 250],
    [0n, 10000n, 0],
    [MAX_MONEY_INPUT_CENTS, 1n, 999999999900],
  ])('floors %p of %p to %p', (part, whole, percent) => {
    expect(floorPercent(part, whole)).toBe(percent);
  });

  it('returns 0 for a zero whole', () => {
    expect(floorPercent(500n, 0n)).toBe(0);
  });

  it('floors toward negative infinity', () => {
    expect(floorPercent(-1n, 3n)).toBe(-34);
  });
});

describe('roundPercentToTenth', () => {
  it.each([
    [10n, 100n, 10],
    [1n, 3n, 33.3],
    [2n, 3n, 66.7],
    [225n, 10000n, 2.3],
    [-225n, 10000n, -2.2],
    [224n, 10000n, 2.2],
    [-226n, 10000n, -2.3],
    [5n, 10000n, 0.1],
    [-5n, 10000n, 0],
    [50n, -100n, -50],
    [-50n, -100n, 50],
    [225n, -10000n, -2.2],
  ])('rounds %p of %p to %p', (part, whole, percent) => {
    expect(roundPercentToTenth(part, whole)).toBe(percent);
  });

  it('returns 0 for a zero whole', () => {
    expect(roundPercentToTenth(500n, 0n)).toBe(0);
  });

  it('matches Math.round on values that are exact in binary', () => {
    for (const [part, whole] of [
      [125n, 1000n],
      [-125n, 1000n],
      [375n, -1000n],
    ] as const) {
      expect(roundPercentToTenth(part, whole)).toBe(Math.round((Number(part) / Number(whole)) * 1000) / 10);
    }
  });
});
