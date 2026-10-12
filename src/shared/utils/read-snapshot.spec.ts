import type { DataSource } from 'typeorm';

import { readSnapshot } from './read-snapshot';

describe('readSnapshot', () => {
  it('runs the reads in one REPEATABLE READ transaction', async () => {
    const manager = {};
    const transaction = jest.fn((_level: string, read: (m: unknown) => Promise<unknown>) => read(manager));
    const read = jest.fn().mockResolvedValue('read');

    await expect(readSnapshot({ transaction } as unknown as DataSource, read)).resolves.toBe('read');
    expect(transaction).toHaveBeenCalledWith('REPEATABLE READ', read);
    expect(read).toHaveBeenCalledWith(manager);
  });
});
