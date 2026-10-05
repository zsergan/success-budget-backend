import { HttpException } from '@nestjs/common';
import { QueryFailedError, type EntityManager } from 'typeorm';

import { IdempotencyService, hashPayload, type IdempotentRequest } from './idempotency.service';
import { IdempotencyKey } from '@entities/idempotency-key.entity';
import { ErrorMessages } from '@shared/error-messages';

const duplicate = () =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('dup'), {
      code: 'ER_DUP_ENTRY',
      sqlMessage: "Duplicate entry for key 'idempotency_keys.UQ_idempotency_keys_scope'",
    }),
  );

describe('IdempotencyService', () => {
  const request: IdempotentRequest = {
    userId: 1,
    spaceId: 10,
    operation: 'transactions.create',
    key: 'key-1',
    payload: { amount: '10', wallet_id: 1 },
  };
  const scope = { user_id: 1, space_id: 10, operation: 'transactions.create', idempotency_key: 'key-1' };

  let service: IdempotencyService;
  let repository: { insert: jest.Mock; findOne: jest.Mock; update: jest.Mock };
  let manager: EntityManager;
  let globalRepository: { query: jest.Mock };

  const storedRow = (overrides: Partial<IdempotencyKey> = {}): IdempotencyKey => ({
    id: '7',
    ...scope,
    request_hash: hashPayload(request.payload),
    response_body: { transaction: { id: 'tx-1' } },
    created_at: new Date(),
    expires_at: new Date(Date.now() + 60_000),
    ...overrides,
  });

  beforeEach(() => {
    repository = { insert: jest.fn(), findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
    manager = { getRepository: jest.fn().mockReturnValue(repository) } as unknown as EntityManager;
    globalRepository = { query: jest.fn() };
    service = new IdempotencyService(globalRepository as never);
  });

  it('claims a new key, runs the work and stores its JSON result', async () => {
    const work = jest.fn().mockResolvedValue({ at: new Date('2026-01-01T00:00:00.000Z'), amount: '10' });

    const result = await service.run(manager, request, work);

    expect(result).toEqual({ at: new Date('2026-01-01T00:00:00.000Z'), amount: '10' });
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, request_hash: hashPayload(request.payload), response_body: null }),
    );
    const [{ created_at, expires_at }] = repository.insert.mock.calls[0];
    expect(expires_at.getTime() - created_at.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(repository.update).toHaveBeenCalledWith(scope, {
      response_body: { at: '2026-01-01T00:00:00.000Z', amount: '10' },
    });
    expect(manager.getRepository).toHaveBeenCalledWith(IdempotencyKey);
  });

  it('replays the stored result of the same request without running the work', async () => {
    repository.insert.mockRejectedValue(duplicate());
    repository.findOne.mockResolvedValue(storedRow());
    const work = jest.fn();

    await expect(service.run(manager, request, work)).resolves.toEqual({ transaction: { id: 'tx-1' } });
    expect(repository.findOne).toHaveBeenCalledWith({ where: scope });
    expect(work).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses the key for a different request', async () => {
    repository.insert.mockRejectedValue(duplicate());
    repository.findOne.mockResolvedValue(storedRow({ request_hash: hashPayload({ amount: '11' }) }));
    const work = jest.fn();

    await expect(service.run(manager, request, work)).rejects.toMatchObject(
      new HttpException(ErrorMessages.IDEMPOTENCY_KEY_REUSED, 409),
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('takes over an expired key and runs the work as new', async () => {
    repository.insert.mockRejectedValue(duplicate());
    repository.findOne.mockResolvedValue(storedRow({ expires_at: new Date(Date.now() - 1) }));
    const work = jest.fn().mockResolvedValue(true);

    await expect(service.run(manager, request, work)).resolves.toBe(true);
    expect(repository.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: '7' }),
      expect.objectContaining({ response_body: null }),
    );
    expect(work).toHaveBeenCalled();
  });

  it('replays when a concurrent request revived the expired key first', async () => {
    repository.insert.mockRejectedValue(duplicate());
    repository.findOne
      .mockResolvedValueOnce(storedRow({ expires_at: new Date(Date.now() - 1) }))
      .mockResolvedValueOnce(storedRow());
    repository.update.mockResolvedValueOnce({ affected: 0 });
    const work = jest.fn();

    await expect(service.run(manager, request, work)).resolves.toEqual({ transaction: { id: 'tx-1' } });
    expect(work).not.toHaveBeenCalled();
  });

  it('claims again when the stored key was purged in between', async () => {
    repository.insert.mockRejectedValueOnce(duplicate()).mockResolvedValueOnce(undefined);
    repository.findOne.mockResolvedValue(null);
    const work = jest.fn().mockResolvedValue(true);

    await expect(service.run(manager, request, work)).resolves.toBe(true);
    expect(repository.insert).toHaveBeenCalledTimes(2);
  });

  it('does not swallow other insert errors', async () => {
    repository.insert.mockRejectedValue(new Error('boom'));

    await expect(service.run(manager, request, jest.fn())).rejects.toThrow('boom');
  });

  it('stores nothing when the work fails', async () => {
    const work = jest.fn().mockRejectedValue(new Error('refused'));

    await expect(service.run(manager, request, work)).rejects.toThrow('refused');
    expect(repository.update).not.toHaveBeenCalled();
  });

  describe('purgeExpired', () => {
    it('deletes a batch of expired keys', async () => {
      await service.purgeExpired();

      expect(globalRepository.query).toHaveBeenCalledWith(
        'DELETE FROM idempotency_keys WHERE expires_at <= ? ORDER BY expires_at LIMIT ?',
        [expect.any(Date), 100],
      );
    });

    it('does not fail the request when purging fails', async () => {
      globalRepository.query.mockRejectedValue(new Error('down'));

      await expect(service.purgeExpired()).resolves.toBeUndefined();
    });
  });
});

describe('hashPayload', () => {
  it('ignores key order and absent fields', () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: undefined } })).toBe(hashPayload({ b: { c: 2 }, a: 1 }));
  });

  it('tells different values apart', () => {
    expect(hashPayload({ amount: '12.3' })).not.toBe(hashPayload({ amount: '12.30' }));
    expect(hashPayload({ expectedVersion: null })).not.toBe(hashPayload({ expectedVersion: 1 }));
  });
});
