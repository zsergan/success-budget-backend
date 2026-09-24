import { HttpException } from '@nestjs/common';

import { assertFound } from './assert-found';

describe('assertFound', () => {
  it('does nothing for a present value, including falsy ones', () => {
    expect(() => assertFound({ id: 1 })).not.toThrow();
    expect(() => assertFound(0)).not.toThrow();
    expect(() => assertFound('')).not.toThrow();
  });

  it('throws a 404 for null or undefined', () => {
    expect(() => assertFound(null)).toThrow(new HttpException('Not found', 404));
    expect(() => assertFound(undefined, 'gone')).toThrow(new HttpException('gone', 404));
  });
});
