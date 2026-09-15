import { HttpException } from '@nestjs/common';

import { assertBelongsToSpace } from './space-ownership';

describe('assertBelongsToSpace', () => {
  it('does nothing when the resource belongs to the space', () => {
    expect(() => assertBelongsToSpace({ space_id: 1 }, 1, 'forbidden')).not.toThrow();
  });

  it('throws a 403 when the resource belongs to a different space', () => {
    expect(() => assertBelongsToSpace({ space_id: 2 }, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
  });

  it('throws a 403 when the resource does not exist', () => {
    expect(() => assertBelongsToSpace(null, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
    expect(() => assertBelongsToSpace(undefined, 1, 'forbidden')).toThrow(new HttpException('forbidden', 403));
  });
});
