import { ApiException } from '@shared/api.exception';
import { assertBelongsToSpace } from './space-ownership';

describe('assertBelongsToSpace', () => {
  const forbidden = new ApiException('FORBIDDEN_WALLET', 403);

  it('does nothing when the resource belongs to the space', () => {
    expect(() => assertBelongsToSpace({ space_id: 1 }, 1, 'FORBIDDEN_WALLET')).not.toThrow();
  });

  it('throws a coded 403 when the resource belongs to a different space', () => {
    expect(() => assertBelongsToSpace({ space_id: 2 }, 1, 'FORBIDDEN_WALLET')).toThrow(forbidden);
  });

  it('throws a coded 403 when the resource does not exist', () => {
    expect(() => assertBelongsToSpace(null, 1, 'FORBIDDEN_WALLET')).toThrow(forbidden);
    expect(() => assertBelongsToSpace(undefined, 1, 'FORBIDDEN_WALLET')).toThrow(forbidden);
  });
});
