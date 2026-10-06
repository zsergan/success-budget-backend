import type { DataSource, EntityManager } from 'typeorm';

import { IdempotencyKeyPurger } from './idempotency-key-purger';

describe('IdempotencyKeyPurger', () => {
  let query: jest.Mock;
  let transaction: jest.Mock;
  let purger: IdempotencyKeyPurger;

  beforeEach(() => {
    query = jest.fn();
    transaction = jest.fn((_level: string, work: (manager: EntityManager) => Promise<unknown>) =>
      work({ query } as unknown as EntityManager),
    );
    purger = new IdempotencyKeyPurger({ transaction } as unknown as DataSource);
  });

  afterEach(() => {
    purger.onModuleDestroy();
    jest.useRealTimers();
  });

  it('deletes a batch of expired keys, skipping locked ones instead of waiting', async () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    query.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]).mockResolvedValueOnce(undefined);

    await expect(purger.purge(now)).resolves.toBe(2);

    expect(transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT id FROM idempotency_keys WHERE expires_at <= ? ORDER BY expires_at LIMIT ? FOR UPDATE SKIP LOCKED',
      [now, 1000],
    );
    expect(query).toHaveBeenNthCalledWith(2, 'DELETE FROM idempotency_keys WHERE id IN (?)', [['1', '2']]);
  });

  it('deletes nothing when no key expired', async () => {
    query.mockResolvedValueOnce([]);

    await expect(purger.purge()).resolves.toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('logs a failure instead of throwing', async () => {
    query.mockRejectedValue(new Error('down'));

    await expect(purger.purge()).resolves.toBe(0);
  });

  it('runs one purge at a time', async () => {
    let release!: (rows: unknown[]) => void;
    query.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const first = purger.purge();
    await expect(purger.purge()).resolves.toBe(0);
    release([]);
    await expect(first).resolves.toBe(0);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('purges on an interval once the application starts, and stops on shutdown', () => {
    jest.useFakeTimers();
    const purge = jest.spyOn(purger, 'purge').mockResolvedValue(0);

    purger.onApplicationBootstrap();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(purge).toHaveBeenCalledTimes(1);

    purger.onModuleDestroy();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
