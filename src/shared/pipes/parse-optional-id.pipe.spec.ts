import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';

import { ParseOptionalIdPipe } from './parse-optional-id.pipe';

describe('ParseOptionalIdPipe', () => {
  const pipe = new ParseOptionalIdPipe();
  const metadata: ArgumentMetadata = { type: 'query', data: 'category_id' };

  it('keeps an absent value undefined', () => {
    expect(pipe.transform(undefined, metadata)).toBeUndefined();
  });

  it('converts a positive integer', () => {
    expect(pipe.transform('42', metadata)).toBe(42);
    expect(pipe.transform('2147483647', metadata)).toBe(2147483647);
    expect(pipe.transform(42, metadata)).toBe(42);
  });

  it.each([
    [''],
    ['0'],
    ['-1'],
    ['1.5'],
    ['01'],
    ['1e3'],
    ['abc'],
    ['2147483648'],
    [['1', '2']],
    [null],
    [NaN],
    [0],
    [1.5],
  ])('rejects %p with a field error', (value) => {
    expect(() => pipe.transform(value, metadata)).toThrow(BadRequestException);

    try {
      pipe.transform(value, metadata);
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: [{ field: 'category_id', error: 'category_id must be a positive integer id' }],
      });
    }
  });
});
