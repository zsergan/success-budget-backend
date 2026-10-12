import { QueryFailedError } from 'typeorm';

import { isDeadlock, isDuplicateKey } from './database-errors';

const queryError = (code: string, sqlMessage = '') =>
  new QueryFailedError('SQL', [], Object.assign(new Error(sqlMessage), { code, sqlMessage }));

describe('isDuplicateKey', () => {
  it('matches a duplicate on the named constraint', () => {
    expect(isDuplicateKey(queryError('ER_DUP_ENTRY', "Duplicate entry 'a' for key 'UQ_a'"), 'UQ_a')).toBe(true);
  });

  it('ignores a duplicate on another constraint', () => {
    expect(isDuplicateKey(queryError('ER_DUP_ENTRY', "Duplicate entry 'a' for key 'UQ_b'"), 'UQ_a')).toBe(false);
  });

  it('ignores other errors', () => {
    expect(isDuplicateKey(queryError('ER_LOCK_DEADLOCK'), 'UQ_a')).toBe(false);
    expect(isDuplicateKey(new Error('UQ_a'), 'UQ_a')).toBe(false);
  });
});

describe('isDeadlock', () => {
  it('matches only a deadlock query error', () => {
    expect(isDeadlock(queryError('ER_LOCK_DEADLOCK'))).toBe(true);
    expect(isDeadlock(queryError('ER_LOCK_WAIT_TIMEOUT'))).toBe(false);
    expect(isDeadlock(new Error('ER_LOCK_DEADLOCK'))).toBe(false);
  });
});
