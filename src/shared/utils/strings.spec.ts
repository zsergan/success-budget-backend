import { generateRandomNumberString } from './strings';

describe('generateRandomNumberString', () => {
  it('always returns a 4-character numeric string', () => {
    for (let i = 0; i < 50; i++) {
      const result = generateRandomNumberString();

      expect(result).toHaveLength(4);
      expect(result).toMatch(/^\d{4}$/);
    }
  });

  it('zero-pads values below 1000', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.00001);

    expect(generateRandomNumberString()).toBe('0000');

    randomSpy.mockRestore();
  });
});
