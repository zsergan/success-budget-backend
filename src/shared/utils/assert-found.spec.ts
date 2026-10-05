import { ApiException } from '@shared/api.exception';
import { assertFound } from './assert-found';

describe('assertFound', () => {
  it('does nothing for a present value, including falsy ones', () => {
    expect(() => assertFound({ id: 1 })).not.toThrow();
    expect(() => assertFound(0)).not.toThrow();
    expect(() => assertFound('')).not.toThrow();
  });

  it('throws a coded 404 for null or undefined', () => {
    expect(() => assertFound(null)).toThrow(new ApiException('NOT_FOUND', 404));
    expect(() => assertFound(undefined, 'TRANSACTION_NOT_FOUND')).toThrow(
      new ApiException('TRANSACTION_NOT_FOUND', 404),
    );
  });
});
