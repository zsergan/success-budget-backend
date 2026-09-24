import { BadRequestException, type ArgumentMetadata } from '@nestjs/common';

import { ParseOptionalDatePipe } from './parse-optional-date.pipe';

describe('ParseOptionalDatePipe', () => {
  const pipe = new ParseOptionalDatePipe();
  const metadata: ArgumentMetadata = { type: 'query', data: 'from' };

  it('keeps an absent value undefined so the handler default applies', () => {
    expect(pipe.transform(undefined, metadata)).toBeUndefined();
  });

  it('converts a valid ISO string into a Date', () => {
    expect(pipe.transform('2026-01-01', metadata)).toEqual(new Date(2026, 0, 1));
  });

  it.each([[''], ['garbage'], [['2026-01-01', '2026-01-02']], [null]])('rejects %p with a field error', (value) => {
    let error: unknown;
    try {
      pipe.transform(value, metadata);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error instanceof BadRequestException && error.getResponse()).toMatchObject({
      message: [{ field: 'from', error: 'from must be a valid ISO 8601 date' }],
    });
  });
});
