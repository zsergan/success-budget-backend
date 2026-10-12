import type { ArgumentMetadata } from '@nestjs/common';

import { ParseOptionalEnumPipe } from './parse-optional-enum.pipe';
import { TransactionType } from '@shared/enums';

describe('ParseOptionalEnumPipe', () => {
  const pipe = new ParseOptionalEnumPipe(TransactionType);
  const metadata: ArgumentMetadata = { type: 'query', data: 'transaction_type' };

  it('keeps an absent value undefined and passes a member through', () => {
    expect(pipe.transform(undefined, metadata)).toBeUndefined();
    expect(pipe.transform('expense', metadata)).toBe(TransactionType.EXPENSE);
  });

  it.each([[''], ['EXPENSE'], ['transfer'], [['income', 'expense']]])('rejects %p with a field error', (value) => {
    expect(() => pipe.transform(value, metadata)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          message: [{ field: 'transaction_type', error: 'transaction_type must be one of: income, expense' }],
        }),
      }),
    );
  });
});
