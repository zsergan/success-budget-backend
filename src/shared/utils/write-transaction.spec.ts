import { QueryFailedError, type DataSource } from 'typeorm';

import { runWriteTransaction } from './write-transaction';

const deadlock = () =>
  new QueryFailedError('SQL', [], Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' }));

const dataSourceRunning = () => {
  const manager = {};
  const transaction = jest.fn((_level: string, work: (m: unknown) => Promise<unknown>) => work(manager));

  return { dataSource: { transaction } as unknown as DataSource, transaction, manager };
};

describe('runWriteTransaction', () => {
  it('runs the work in a READ COMMITTED transaction', async () => {
    const { dataSource, transaction, manager } = dataSourceRunning();
    const work = jest.fn().mockResolvedValue('done');

    await expect(runWriteTransaction(dataSource, work)).resolves.toBe('done');
    expect(transaction).toHaveBeenCalledWith('READ COMMITTED', work);
    expect(work).toHaveBeenCalledWith(manager);
  });

  it('runs the work again after a deadlock', async () => {
    const { dataSource } = dataSourceRunning();
    const work = jest.fn().mockRejectedValueOnce(deadlock()).mockResolvedValue('done');

    await expect(runWriteTransaction(dataSource, work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('gives up after three deadlocks', async () => {
    const { dataSource } = dataSourceRunning();
    const work = jest.fn().mockRejectedValue(deadlock());

    await expect(runWriteTransaction(dataSource, work)).rejects.toBeInstanceOf(QueryFailedError);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('does not repeat the work after another error', async () => {
    const { dataSource } = dataSourceRunning();
    const work = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(runWriteTransaction(dataSource, work)).rejects.toThrow('boom');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
