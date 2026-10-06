import { BadRequestException } from '@nestjs/common';

import { ParseIfMatchVersionPipe } from './parse-if-match-version.pipe';

describe('ParseIfMatchVersionPipe', () => {
  const pipe = new ParseIfMatchVersionPipe();

  it('passes an absent header through', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it.each([
    ['"3"', 3],
    ['3', 3],
    [' "12" ', 12],
    ['"4294967295"', 4294967295],
  ])('reads %p as version %p', (header, version) => {
    expect(pipe.transform(header)).toBe(version);
  });

  it.each(['', '"0"', '"-1"', '"3', '3"', 'W/"3"', '*', '"1", "2"', '"abc"', '"4294967296"', '"01"'])(
    'rejects %p',
    (header) => {
      expect(() => pipe.transform(header)).toThrow(BadRequestException);
    },
  );

  it('names the header in the field error', () => {
    try {
      pipe.transform('*');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: [{ field: 'If-Match', error: 'If-Match must be a record version, e.g. "3"' }],
      });
    }
    expect.assertions(1);
  });
});
