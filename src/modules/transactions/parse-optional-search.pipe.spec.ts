import { BadRequestException } from '@nestjs/common';

import { ParseOptionalSearchPipe } from './parse-optional-search.pipe';

describe('ParseOptionalSearchPipe', () => {
  const pipe = new ParseOptionalSearchPipe();

  const errorOf = (value: unknown) => {
    try {
      pipe.transform(value);
    } catch (error) {
      return ((error as BadRequestException).getResponse() as { message: unknown }).message;
    }

    throw new Error('expected an error');
  };

  it.each<[unknown, string | undefined]>([
    [undefined, undefined],
    ['', undefined],
    ['   ', undefined],
    ['  coffee  beans ', 'coffee  beans'],
    [` ${'🙂'.repeat(255)} `, '🙂'.repeat(255)],
  ])('reads %p as %p', (value, expected) => {
    expect(pipe.transform(value)).toBe(expected);
  });

  it('refuses, not cuts, more than 255 characters after trimming', () => {
    expect(errorOf('x'.repeat(256))).toEqual([{ field: 'q', error: 'q must be at most 255 characters' }]);
  });

  it('refuses a repeated q', () => {
    expect(errorOf(['a', 'b'])).toEqual([{ field: 'q', error: 'q must be a string' }]);
  });
});
