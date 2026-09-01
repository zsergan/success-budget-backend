jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto') as { randomInt: jest.Mock };

import { constantTimeEquals, generateRandomNumberString } from './strings';

describe('generateRandomNumberString', () => {
  afterEach(() => {
    crypto.randomInt.mockReset();
  });

  it('always returns a 6-character numeric string', () => {
    crypto.randomInt.mockImplementation((_min: number, max: number) => Math.floor(Math.random() * max));

    for (let i = 0; i < 50; i++) {
      const result = generateRandomNumberString();

      expect(result).toHaveLength(6);
      expect(result).toMatch(/^\d{6}$/);
    }
  });

  it('zero-pads values below 100000', () => {
    crypto.randomInt.mockReturnValue(1);

    expect(generateRandomNumberString()).toBe('000001');
  });

  it('draws from the full 6-digit range via node:crypto.randomInt', () => {
    crypto.randomInt.mockReturnValue(0);

    generateRandomNumberString();

    expect(crypto.randomInt).toHaveBeenCalledWith(0, 1000000);
  });
});

describe('constantTimeEquals', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEquals('123456', '654321')).toBe(false);
  });

  it('returns false for strings of different lengths without throwing', () => {
    expect(constantTimeEquals('123456', '1234567')).toBe(false);
  });
});
