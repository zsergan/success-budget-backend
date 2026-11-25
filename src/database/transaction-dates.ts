import { createHash } from 'crypto';
import type { DataSource } from 'typeorm';

import { formatMoney, parseMoney } from '@shared/utils';
import { assertLegacyZoneData, legacyDateOf } from './legacy-transaction-dates';

// Deploy check of ReplaceTransactionTimestampWithDate1791500000000
// (docs/deployment.md#rolling-out-calendar-dates). A ledger taken before
// the migration reads each record's instant as its Chicago day, the way the
// migration dates it; the ledger after it reads the stored date and order.
// Both must be equal: every record, its date, the order of the history,
// every day and month total, the starting balances, the operation records,
// and no retained result may still carry a timestamp.

export interface DateSchema {
  hasTimestamp: boolean;
  hasDate: boolean;
}

export interface DateTotals {
  space_id: number;
  // a day YYYY-MM-DD or a month YYYY-MM
  period: string;
  income: string;
  expense: string;
  count: number;
}

export interface SpaceDates {
  space_id: number;
  transactions: number;
  // sha256 of every record by id: its fields and its date
  records: string;
  // sha256 of the ids in the history order, oldest first
  order: string;
}

export interface DateLedger {
  taken_at: string;
  // which schema it was read from: 'timestamp' before the migration, 'date' after
  read_from: 'timestamp' | 'date';
  transactions: number;
  spaces: SpaceDates[];
  // ordinary records only: starting balances are apart
  days: DateTotals[];
  months: DateTotals[];
  initial_balances: { space_id: number; count: number; amount: string }[];
  operations: number;
  // idempotency results that embed a transaction view
  stored_results: number;
  // of those, the ones still holding transaction.timestamp
  stored_results_with_timestamp: number;
}

interface LedgerRow {
  id: string;
  space_id: number;
  category_id: number;
  is_system: number;
  transaction_type: string;
  amount: string;
  epoch_ms?: string | number;
  date?: string;
  description: string | null;
  version: number;
  author_user_id: number | null;
  author_source: string;
  assignment_kind: string;
  assigned_user_id: number | null;
}

const BATCH = 5000;
const TRANSACTION_RESULTS =
  "operation LIKE 'transactions.%' AND JSON_CONTAINS_PATH(response_body, 'one', '$.transaction')";

const nullableNumber = (value: number | string | null): number | null => (value === null ? null : Number(value));

export async function readDateSchema(dataSource: DataSource): Promise<DateSchema> {
  const columns: { COLUMN_NAME: string }[] = await dataSource.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME IN ('timestamp', 'date')`,
  );
  const names = new Set(columns.map((column) => column.COLUMN_NAME));

  return { hasTimestamp: names.has('timestamp'), hasDate: names.has('date') };
}

// Streams the records by id; sums are exact cents.
export async function readDateLedger(dataSource: DataSource): Promise<DateLedger> {
  const { hasTimestamp } = await readDateSchema(dataSource);

  if (hasTimestamp) {
    assertLegacyZoneData();
  }

  const day = hasTimestamp
    ? 'CAST(ROUND(UNIX_TIMESTAMP(t.timestamp) * 1000) AS SIGNED) AS epoch_ms'
    : "DATE_FORMAT(t.date, '%Y-%m-%d') AS date";
  const spaces = new Map<number, { transactions: number; records: ReturnType<typeof createHash> }>();
  const days = new Map<string, DateTotals & { cents: { income: bigint; expense: bigint } }>();
  const balances = new Map<number, { count: number; amount: bigint }>();
  let total = 0;

  for (let after = ''; ;) {
    const rows: LedgerRow[] = await dataSource.query(
      `SELECT t.id, t.space_id, t.category_id, c.is_system, t.transaction_type, t.amount, ${day}, t.description,
              t.version, t.author_user_id, t.author_source, t.assignment_kind, t.assigned_user_id
       FROM transactions t INNER JOIN categories c ON c.id = t.category_id
       WHERE t.id > ? ORDER BY t.id LIMIT ${BATCH}`,
      [after],
    );

    for (const row of rows) {
      const spaceId = Number(row.space_id);
      const date = row.date ?? legacyDateOf(Number(row.epoch_ms));
      const space = spaces.get(spaceId) ?? { transactions: 0, records: createHash('sha256') };
      const amount = parseMoney(row.amount);

      space.transactions++;
      space.records.update(
        JSON.stringify([
          row.id,
          date,
          Number(row.category_id),
          row.transaction_type,
          row.amount,
          row.description,
          Number(row.version),
          nullableNumber(row.author_user_id),
          row.author_source,
          row.assignment_kind,
          nullableNumber(row.assigned_user_id),
        ]),
      );
      spaces.set(spaceId, space);

      if (Number(row.is_system)) {
        const sums = balances.get(spaceId) ?? { count: 0, amount: 0n };
        balances.set(spaceId, { count: sums.count + 1, amount: sums.amount + amount });
        continue;
      }

      const key = `${String(spaceId).padStart(10, '0')}/${date}`;
      const sums = days.get(key) ?? {
        space_id: spaceId,
        period: date,
        income: '',
        expense: '',
        count: 0,
        cents: { income: 0n, expense: 0n },
      };
      sums.count++;
      sums.cents[row.transaction_type === 'income' ? 'income' : 'expense'] += amount;
      days.set(key, sums);
    }

    total += rows.length;

    if (rows.length < BATCH) {
      break;
    }

    after = rows[rows.length - 1].id;
  }

  const sortedDays = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, sums]) => sums);
  const months = new Map<string, DateTotals & { cents: { income: bigint; expense: bigint } }>();

  for (const sums of sortedDays) {
    const key = `${String(sums.space_id).padStart(10, '0')}/${sums.period.slice(0, 7)}`;
    const month = months.get(key) ?? {
      space_id: sums.space_id,
      period: sums.period.slice(0, 7),
      income: '',
      expense: '',
      count: 0,
      cents: { income: 0n, expense: 0n },
    };
    month.count += sums.count;
    month.cents.income += sums.cents.income;
    month.cents.expense += sums.cents.expense;
    months.set(key, month);
  }

  const formatTotals = ({ cents, ...rest }: DateTotals & { cents: { income: bigint; expense: bigint } }) => ({
    ...rest,
    income: formatMoney(cents.income),
    expense: formatMoney(cents.expense),
  });
  const spaceIds = [...spaces.keys()].sort((a, b) => a - b);

  return {
    taken_at: new Date().toISOString(),
    read_from: hasTimestamp ? 'timestamp' : 'date',
    transactions: total,
    spaces: await Promise.all(
      spaceIds.map(async (spaceId) => ({
        space_id: spaceId,
        transactions: spaces.get(spaceId)!.transactions,
        records: spaces.get(spaceId)!.records.digest('hex'),
        order: await readOrderDigest(dataSource, spaceId, hasTimestamp),
      })),
    ),
    days: sortedDays.map(formatTotals),
    months: [...months.values()].map(formatTotals),
    initial_balances: [...balances.entries()]
      .sort(([a], [b]) => a - b)
      .map(([spaceId, sums]) => ({ space_id: spaceId, count: sums.count, amount: formatMoney(sums.amount) })),
    operations: await countRows(dataSource, 'SELECT COUNT(*) AS count FROM transaction_operations'),
    stored_results: await countRows(
      dataSource,
      `SELECT COUNT(*) AS count FROM idempotency_keys WHERE ${TRANSACTION_RESULTS}`,
    ),
    stored_results_with_timestamp: await countRows(
      dataSource,
      `SELECT COUNT(*) AS count FROM idempotency_keys
       WHERE ${TRANSACTION_RESULTS} AND JSON_CONTAINS_PATH(response_body, 'one', '$.transaction.timestamp')`,
    ),
  };
}

// The history order oldest first: (timestamp, id) before the migration,
// (date, ordering key) after it, which the migration made the same.
async function readOrderDigest(dataSource: DataSource, spaceId: number, hasTimestamp: boolean): Promise<string> {
  const order = hasTimestamp ? 'UNIX_TIMESTAMP(timestamp), id' : 'date, order_key';
  const rows: { id: string }[] = await dataSource.query(
    `SELECT id FROM transactions WHERE space_id = ? ORDER BY ${order}`,
    [spaceId],
  );
  const hash = createHash('sha256');
  rows.forEach((row) => hash.update(`${row.id}\n`));

  return hash.digest('hex');
}

async function countRows(dataSource: DataSource, sql: string): Promise<number> {
  const [row]: { count: string | number }[] = await dataSource.query(sql);

  return Number(row.count);
}

// Every difference between a ledger taken before the migration and one
// taken after it, as lines to print; none means the history was preserved.
export function compareDateLedgers(before: DateLedger, after: DateLedger): string[] {
  const differences: string[] = [];

  if (before.read_from !== 'timestamp') {
    differences.push('the snapshot was not taken before the migration: it holds no timestamps');
  }

  if (after.read_from !== 'date') {
    differences.push('the database still has transactions.timestamp: the migration has not finished');
  }

  for (const field of ['transactions', 'operations', 'stored_results'] as const) {
    if (before[field] !== after[field]) {
      differences.push(`${field}: ${before[field]} before, ${after[field]} after`);
    }
  }

  if (after.stored_results_with_timestamp) {
    differences.push(`${after.stored_results_with_timestamp} retained results still hold transaction.timestamp`);
  }

  const compare = <T>(label: string, key: (item: T) => string, a: T[], b: T[]) => {
    const left = new Map(a.map((item) => [key(item), JSON.stringify(item)]));
    const right = new Map(b.map((item) => [key(item), JSON.stringify(item)]));

    for (const id of new Set([...left.keys(), ...right.keys()])) {
      if (left.get(id) !== right.get(id)) {
        differences.push(`${label} ${id}: ${left.get(id) ?? 'missing'} before, ${right.get(id) ?? 'missing'} after`);
      }
    }
  };

  compare<SpaceDates>('space', (space) => String(space.space_id), before.spaces, after.spaces);
  compare<DateTotals>('day', (day) => `${day.space_id}/${day.period}`, before.days, after.days);
  compare<DateTotals>('month', (month) => `${month.space_id}/${month.period}`, before.months, after.months);
  compare<DateLedger['initial_balances'][number]>(
    'initial balances of space',
    (balances) => String(balances.space_id),
    before.initial_balances,
    after.initial_balances,
  );

  return differences;
}
