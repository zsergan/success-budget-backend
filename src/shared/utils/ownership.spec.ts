import { HttpException } from '@nestjs/common';

import { assertOwnership } from './ownership';

describe('assertOwnership', () => {
  it('does nothing when the resource belongs to the user', () => {
    expect(() => assertOwnership({ user_id: 1 }, 1, 'forbidden')).not.toThrow();
  });

  it('throws a 403 when the resource belongs to someone else', () => {
    expect(() => assertOwnership({ user_id: 2 }, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
  });

  it('throws a 403 when the resource does not exist', () => {
    expect(() => assertOwnership(null, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
    expect(() => assertOwnership(undefined, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
  });
});
