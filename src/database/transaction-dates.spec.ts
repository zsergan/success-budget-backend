import type { DataSource } from 'typeorm';

import { type DateLedger, compareDateLedgers, readDateLedger, readDateSchema } from './transaction-dates';

interface Record {
  id: string;
  space_id: number;
  is_system: number;
  transaction_type: 'income' | 'expense';
  amount: string;
  instant: string;
  date: string;
}

const record = (
  id: string,
  spaceId: number,
  type: Record['transaction_type'],
  amount: string,
  instant: string,
  date: string,
  isSystem = 0,
): Record => ({
  id,
  space_id: spaceId,
  is_system: isSystem,
  transaction_type: type,
  amount,
  instant,
  date,
});

const RECORDS = [
  record('1', 1, 'income', '100.00', '2026-01-01T12:00:00.000Z', '2026-01-01', 1),
  record('2', 1, 'expense', '12.50', '2026-03-01T05:30:00.000Z', '2026-02-28'),
  record('3', 1, 'income', '1000.00', '2026-03-01T06:30:00.000Z', '2026-03-01'),
  record('4', 1, 'expense', '0.75', '2026-02-28T18:00:00.000Z', '2026-02-28'),
  record('5', 2, 'expense', '3.10', '2026-02-28T20:00:00.000Z', '2026-02-28'),
];
const ORDER: { [spaceId: number]: string[] } = { 1: ['1', '4', '2', '3'], 2: ['5'] };

// Answers the ledger's queries from the records, as the schema before
// (timestamp) or after (date) the migration holds them.
const fakeDataSource = (
  schema: 'timestamp' | 'date',
  records: Record[] = RECORDS,
  { operations = 4, stored = 3, withTimestamp = 0 } = {},
) => {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('information_schema.COLUMNS')) {
      return [{ COLUMN_NAME: schema }];
    }

    if (sql.includes('INNER JOIN categories')) {
      const after = params[0] === '' ? 0 : Number(params[0]);

      return records
        .filter((row) => Number(row.id) > after)
        .slice(0, 5000)
        .map(({ instant, date, ...row }) => ({
          ...row,
          category_id: row.is_system ? 1 : 10 + row.space_id,
          description: null,
          version: 1,
          author_user_id: row.space_id === 2 ? null : '7',
          author_source: 'user',
          assignment_kind: 'space',
          assigned_user_id: null,
          ...(schema === 'timestamp' ? { epoch_ms: String(Date.parse(instant)) } : { date }),
        }));
    }

    if (sql.includes('SELECT id FROM transactions WHERE space_id')) {
      return (ORDER[params[0] as number] ?? records.map((row) => row.id)).map((id) => ({ id }));
    }

    if (sql.includes('transaction_operations')) {
      return [{ count: String(operations) }];
    }

    if (sql.includes("'$.transaction.timestamp'")) {
      return [{ count: withTimestamp }];
    }

    if (sql.includes('idempotency_keys')) {
      return [{ count: stored }];
    }

    throw new Error(`Unexpected query: ${sql}`);
  });

  return { dataSource: { query } as unknown as DataSource, query };
};

describe('transaction date ledger', () => {
  it('reads which of the two columns the schema has', async () => {
    expect(await readDateSchema(fakeDataSource('timestamp').dataSource)).toEqual({
      hasTimestamp: true,
      hasDate: false,
    });
    expect(await readDateSchema(fakeDataSource('date').dataSource)).toEqual({ hasTimestamp: false, hasDate: true });
  });

  it('dates each instant by its Chicago day before the migration', async () => {
    const { dataSource, query } = fakeDataSource('timestamp');
    const ledger = await readDateLedger(dataSource);

    expect(query.mock.calls.find(([sql]) => sql.includes('INNER JOIN'))![0]).toContain('AS epoch_ms');
    expect(ledger).toMatchObject({
      read_from: 'timestamp',
      transactions: 5,
      days: [
        { space_id: 1, period: '2026-02-28', income: '0.00', expense: '13.25', count: 2 },
        { space_id: 1, period: '2026-03-01', income: '1000.00', expense: '0.00', count: 1 },
        { space_id: 2, period: '2026-02-28', income: '0.00', expense: '3.10', count: 1 },
      ],
      months: [
        { space_id: 1, period: '2026-02', income: '0.00', expense: '13.25', count: 2 },
        { space_id: 1, period: '2026-03', income: '1000.00', expense: '0.00', count: 1 },
        { space_id: 2, period: '2026-02', income: '0.00', expense: '3.10', count: 1 },
      ],
      initial_balances: [{ space_id: 1, count: 1, amount: '100.00' }],
      operations: 4,
      stored_results: 3,
      stored_results_with_timestamp: 0,
    });
    expect(ledger.spaces.map(({ space_id, transactions }) => [space_id, transactions])).toEqual([
      [1, 4],
      [2, 1],
    ]);
  });

  it('reads the stored dates after it, and finds them equal to the Chicago days', async () => {
    const before = await readDateLedger(fakeDataSource('timestamp').dataSource);
    const { dataSource, query } = fakeDataSource('date');
    const after = await readDateLedger(dataSource);

    expect(query.mock.calls.find(([sql]) => sql.includes('INNER JOIN'))![0]).toContain('DATE_FORMAT(t.date');
    expect(after.read_from).toBe('date');
    expect(compareDateLedgers(before, after)).toEqual([]);
  });

  it('reads the records in batches', async () => {
    const many = Array.from({ length: 5001 }, (_, index) =>
      record(String(index + 1), 3, 'expense', '1.00', '2026-05-10T15:00:00.000Z', '2026-05-10'),
    );
    const { dataSource, query } = fakeDataSource('date', many);
    const ledger = await readDateLedger(dataSource);
    const batches = query.mock.calls.filter(([sql]) => sql.includes('INNER JOIN'));

    expect(batches.map(([, params]) => params)).toEqual([[''], ['5000']]);
    expect(ledger.transactions).toBe(5001);
    expect(ledger.days).toEqual([
      { space_id: 3, period: '2026-05-10', income: '0.00', expense: '5001.00', count: 5001 },
    ]);
  });

  describe('compareDateLedgers', () => {
    let before: DateLedger;
    let after: DateLedger;

    beforeEach(async () => {
      before = await readDateLedger(fakeDataSource('timestamp').dataSource);
      after = await readDateLedger(fakeDataSource('date').dataSource);
    });

    it('refuses ledgers read from the wrong side of the migration', () => {
      expect(compareDateLedgers(after, before)).toEqual(
        expect.arrayContaining([
          'the snapshot was not taken before the migration: it holds no timestamps',
          'the database still has transactions.timestamp: the migration has not finished',
        ]),
      );
    });

    it('reports changed counts and results that still hold a timestamp', () => {
      after = { ...after, operations: 3, stored_results: 2, stored_results_with_timestamp: 1 };

      expect(compareDateLedgers(before, after)).toEqual([
        'operations: 4 before, 3 after',
        'stored_results: 3 before, 2 after',
        '1 retained results still hold transaction.timestamp',
      ]);
    });

    it('reports a record that moved to another day, with the totals it changed', async () => {
      const moved = RECORDS.map((row) => (row.id === '2' ? { ...row, date: '2026-03-01' } : row));
      after = await readDateLedger(fakeDataSource('date', moved).dataSource);
      const differences = compareDateLedgers(before, after);

      expect(differences).toEqual([
        expect.stringMatching(/^space 1: /),
        expect.stringMatching(/^day 1\/2026-02-28: .*"expense":"13.25".* before, .*"expense":"0.75".* after$/),
        expect.stringMatching(/^day 1\/2026-03-01: /),
        expect.stringMatching(/^month 1\/2026-02: /),
        expect.stringMatching(/^month 1\/2026-03: /),
      ]);
    });

    it('reports missing spaces, days and starting balances', async () => {
      after = await readDateLedger(fakeDataSource('date', RECORDS.slice(0, 1)).dataSource);
      after = { ...after, transactions: 5, initial_balances: [] };

      expect(compareDateLedgers(before, after)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^space 2: .* before, missing after$/),
          expect.stringMatching(/^day 2\/2026-02-28: .* before, missing after$/),
          expect.stringMatching(/^initial balances of space 1: .* before, missing after$/),
        ]),
      );
    });
  });
});
