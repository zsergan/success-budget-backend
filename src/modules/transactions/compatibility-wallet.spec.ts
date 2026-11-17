import { QueryFailedError, type EntityManager } from 'typeorm';

import { Wallet } from '@entities/wallet.entity';
import { LockSetChanged } from '@shared/utils';
import { buildWallet } from '@testing';
import { COMPATIBILITY_WALLET_NAME, lockCompatibilityWallet } from './compatibility-wallet';

describe('lockCompatibilityWallet', () => {
  const managerWith = (existing: Wallet | null, locked: Wallet[] = []) => {
    const repository = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn((wallet: Partial<Wallet>) => wallet),
      save: jest.fn(async (wallet: Partial<Wallet>) => buildWallet({ ...wallet, id: 99 })),
    };
    const lockQuery = {
      setLock: jest.fn().mockReturnThis(),
      whereInIds: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(locked),
    };
    const manager = {
      getRepository: jest.fn().mockReturnValue(repository),
      createQueryBuilder: jest.fn().mockReturnValue(lockQuery),
    } as unknown as EntityManager;

    return { manager, repository, lockQuery };
  };

  it('locks the marked wallet of the space exclusively', async () => {
    const wallet = buildWallet({ id: 5, space_id: 10, compat_space_id: 10 });
    const { manager, repository, lockQuery } = managerWith(wallet, [wallet]);

    await expect(lockCompatibilityWallet(manager, 10)).resolves.toBe(wallet);
    expect(repository.findOne).toHaveBeenCalledWith({ select: { id: true }, where: { compat_space_id: 10 } });
    expect(lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('runs the unit again when the wallet was deleted between the read and the lock', async () => {
    const { manager } = managerWith(buildWallet({ id: 5 }), [buildWallet({ id: 5, compat_space_id: null })]);

    await expect(lockCompatibilityWallet(manager, 10)).rejects.toBeInstanceOf(LockSetChanged);
  });

  it('creates the marked wallet when the space has none', async () => {
    const { manager, repository } = managerWith(null);

    await expect(lockCompatibilityWallet(manager, 10)).resolves.toEqual(expect.objectContaining({ id: 99 }));
    expect(repository.create).toHaveBeenCalledWith({
      space_id: 10,
      wallet_name: COMPATIBILITY_WALLET_NAME,
      design: 'slate',
      compat_space_id: 10,
    });
  });

  it('runs the unit again when a concurrent create made it first', async () => {
    const { manager, repository } = managerWith(null);
    repository.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], {
        code: 'ER_DUP_ENTRY',
        sqlMessage: "Duplicate entry '10' for key 'wallets.UQ_wallets_compat_space'",
      } as never),
    );

    await expect(lockCompatibilityWallet(manager, 10)).rejects.toBeInstanceOf(LockSetChanged);
  });

  it('passes on any other failure', async () => {
    const { manager, repository } = managerWith(null);
    repository.save.mockRejectedValue(new Error('lost connection'));

    await expect(lockCompatibilityWallet(manager, 10)).rejects.toThrow('lost connection');
  });
});
