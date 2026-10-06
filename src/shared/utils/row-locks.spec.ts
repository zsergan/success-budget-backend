import type { EntityManager } from 'typeorm';

import { lockRows } from './row-locks';
import { Wallet } from '@entities/wallet.entity';

const managerReturning = (rows: unknown[]) => {
  const queryBuilder = {
    setLock: jest.fn().mockReturnThis(),
    whereInIds: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  const manager = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) } as unknown as EntityManager;

  return { manager, queryBuilder };
};

describe('lockRows', () => {
  it('locks the rows exclusively in ascending id order', async () => {
    const rows = [{ id: 2 }, { id: 7 }];
    const { manager, queryBuilder } = managerReturning(rows);

    await expect(lockRows(manager, Wallet, [7, 2, 7], 'exclusive')).resolves.toBe(rows);
    expect(manager.createQueryBuilder).toHaveBeenCalledWith(Wallet, 'row');
    expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(queryBuilder.whereInIds).toHaveBeenCalledWith([2, 7]);
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('row.id', 'ASC');
  });

  it('takes shared locks when asked to', async () => {
    const { manager, queryBuilder } = managerReturning([]);

    await lockRows(manager, Wallet, [1], 'shared');

    expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
  });

  it('reads nothing for no ids', async () => {
    const { manager } = managerReturning([]);

    await expect(lockRows(manager, Wallet, [], 'shared')).resolves.toEqual([]);
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
  });
});
