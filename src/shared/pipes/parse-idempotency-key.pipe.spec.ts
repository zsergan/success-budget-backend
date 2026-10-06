import { BadRequestException } from '@nestjs/common';

import { ParseIdempotencyKeyPipe } from './parse-idempotency-key.pipe';

describe('ParseIdempotencyKeyPipe', () => {
  const pipe = new ParseIdempotencyKeyPipe();

  it('passes an absent header through', () => {
    expect(pipe.transform(undefined)).toBeUndefined();
  });

  it.each(['6f1c1c1e-6a3b-4d6e-9b1a-0c2f3e4d5a6b', 'a', 'A:b_c.d-1', 'x'.repeat(255)])('accepts %p', (key) => {
    expect(pipe.transform(key)).toBe(key);
  });

  it.each(['', 'has space', 'x'.repeat(256), 'ключ', 'tab\there'])('rejects %p', (key) => {
    expect(() => pipe.transform(key)).toThrow(BadRequestException);
  });
});
