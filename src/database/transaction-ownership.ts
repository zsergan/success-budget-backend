import { createHash } from 'crypto';
import type { DataSource } from 'typeorm';

import { formatMoney, parseMoney } from '@shared/utils';

// Deploy checks for the migrations that changed who owns a transaction
// (docs/deployment.md): AddTransactionSpaceOwnership1791200000000 moved every
// record from its wallet to its space, DropWallets1791400000000 removed the
// wallets. Each step has a preflight and a ledger of the history taken
// before and after it, compared field by field. The ledger never reads the
// wallet of a record, and its space through space_id once that column
// exists, so it stays comparable across both migrations.

export interface OwnershipSchema {
  // transactions.space_id and the author and assignment columns
  hasOwners: boolean;
  // transactions.wallet_id and the wallets table
  hasWallets: boolean;
}

export interface OwnershipProblems {
  transactionsWithoutWallet: string[];
  walletsWithoutSpace: number[];
  spacesWithoutMembers: { space_id: number; transactions: number }[];
}

export interface SpaceLedger {
  space_id: number;
  transactions: number;
  // sha256 of every record of the space, by id
  digest: string;
  // sha256 of the author and assignment of every record, by id; absent
  // before the space-ownership migration added them
  owners?: string;
}

export interface MonthTotals {
  space_id: number;
  // UTC
  month: string;
  income: string;
  expense: string;
  count: number;
}

export interface InitialBalances {
  space_id: number;
  count: number;
  amount: string;
}

export interface TransactionLedger {
  taken_at: string;
  transactions: number;
  spaces: SpaceLedger[];
  // ordinary records only: initial balances are apart
  months: MonthTotals[];
  initial_balances: InitialBalances[];
}

export interface OwnershipInvariants {
  // space_id differs from the wallet's space; 0 once wallets are gone
  misplaced: number;
  // none right after the space-ownership migration; later only records of
  // deleted accounts
  withoutAuthor: number;
  // a user on a space or unassigned record
  inconsistentAssignments: number;
}

const BATCH = 5000;

export async function readOwnershipSchema(dataSource: DataSource): Promise<OwnershipSchema> {
  const columns: { COLUMN_NAME: string }[] = await dataSource.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME IN ('space_id', 'wallet_id')`,
  );
  const names = new Set(columns.map((column) => column.COLUMN_NAME));

  return { hasOwners: names.has('space_id'), hasWallets: names.has('wallet_id') };
}

// The preflight of AddTransactionSpaceOwnership1791200000000: what it would
// refuse to move.
export async function findOwnershipProblems(dataSource: DataSource): Promise<OwnershipProblems> {
  const orphans: { id: string }[] = await dataSource.query(
    `SELECT t.id FROM transactions t LEFT JOIN wallets w ON w.id = t.wallet_id WHERE w.id IS NULL ORDER BY t.id`,
  );
  const walletsWithoutSpace: { id: number }[] = await dataSource.query(
    `SELECT DISTINCT w.id FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id
     LEFT JOIN spaces s ON s.id = w.space_id WHERE s.id IS NULL ORDER BY w.id`,
  );
  const memberless: { space_id: number; transactions: string | number }[] = await dataSource.query(
    `SELECT w.space_id, COUNT(*) AS transactions FROM transactions t
     INNER JOIN wallets w ON w.id = t.wallet_id INNER JOIN spaces s ON s.id = w.space_id
     WHERE NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = w.space_id)
     GROUP BY w.space_id ORDER BY w.space_id`,
  );

  return {
    transactionsWithoutWallet: orphans.map((row) => row.id),
    walletsWithoutSpace: walletsWithoutSpace.map((row) => Number(row.id)),
    spacesWithoutMembers: memberless.map((row) => ({
      space_id: Number(row.space_id),
      transactions: Number(row.transactions),
    })),
  };
}

export const hasOwnershipProblems = (problems: OwnershipProblems): boolean =>
  problems.transactionsWithoutWallet.length > 0 ||
  problems.walletsWithoutSpace.length > 0 ||
  problems.spacesWithoutMembers.length > 0;

// The preflight of DropWallets1791400000000: records whose space_id is not
// their wallet's space, which it refuses to drop the wallets over.
export async function findMisplacedTransactions(dataSource: DataSource): Promise<string[]> {
  const rows: { id: string }[] = await dataSource.query(
    `SELECT t.id FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id
     WHERE w.space_id <> t.space_id ORDER BY t.id`,
  );

  return rows.map((row) => row.id);
}

interface LedgerRow {
  id: string;
  space_id: number;
  category_id: number;
  is_system: number;
  transaction_type: string;
  amount: string;
  timestamp_ms: string | number;
  description: string | null;
  version: number;
  author_user_id?: number | null;
  author_source?: string;
  assignment_kind?: string;
  assigned_user_id?: number | null;
}

interface MonthSums {
  income: bigint;
  expense: bigint;
  count: number;
}

type Hash = ReturnType<typeof createHash>;

const byKey = <T>(map: Map<string, T>) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const nullableNumber = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

// Streams the records by id, so a large history is never held in memory.
// Sums are in exact cents; months are UTC.
export async function readTransactionLedger(dataSource: DataSource): Promise<TransactionLedger> {
  const { hasOwners } = await readOwnershipSchema(dataSource);
  const spaces = new Map<number, { transactions: number; hash: Hash; owners?: Hash }>();
  const months = new Map<string, MonthSums & { space_id: number; month: string }>();
  const initialBalances = new Map<number, { count: number; amount: bigint }>();
  const space = hasOwners ? 't.space_id' : 'w.space_id';
  const ownerColumns = hasOwners ? ', t.author_user_id, t.author_source, t.assignment_kind, t.assigned_user_id' : '';
  const walletJoin = hasOwners ? '' : 'INNER JOIN wallets w ON w.id = t.wallet_id';
  let after = '';
  let total = 0;

  for (;;) {
    const rows: LedgerRow[] = await dataSource.query(
      `SELECT t.id, ${space} AS space_id, t.category_id, c.is_system, t.transaction_type, t.amount,
              CAST(ROUND(UNIX_TIMESTAMP(t.timestamp) * 1000) AS UNSIGNED) AS timestamp_ms, t.description,
              t.version${ownerColumns}
       FROM transactions t
       ${walletJoin}
       INNER JOIN categories c ON c.id = t.category_id
       WHERE t.id > ? ORDER BY t.id LIMIT ${BATCH}`,
      [after],
    );

    for (const row of rows) {
      const spaceId = Number(row.space_id);
      const ledger = spaces.get(spaceId) ?? {
        transactions: 0,
        hash: createHash('sha256'),
        ...(hasOwners && { owners: createHash('sha256') }),
      };
      const amount = parseMoney(row.amount);

      ledger.transactions++;
      ledger.hash.update(
        JSON.stringify([
          row.id,
          Number(row.category_id),
          row.transaction_type,
          row.amount,
          String(row.timestamp_ms),
          row.description,
          Number(row.version),
        ]),
      );
      ledger.owners?.update(
        JSON.stringify([
          row.id,
          nullableNumber(row.author_user_id),
          row.author_source,
          row.assignment_kind,
          nullableNumber(row.assigned_user_id),
        ]),
      );
      spaces.set(spaceId, ledger);

      if (Number(row.is_system)) {
        const balances = initialBalances.get(spaceId) ?? { count: 0, amount: 0n };
        initialBalances.set(spaceId, { count: balances.count + 1, amount: balances.amount + amount });
      } else {
        const month = new Date(Number(row.timestamp_ms)).toISOString().slice(0, 7);
        const key = `${String(spaceId).padStart(10, '0')}/${month}`;
        const sums = months.get(key) ?? { space_id: spaceId, month, income: 0n, expense: 0n, count: 0 };

        sums.count++;
        sums[row.transaction_type === 'income' ? 'income' : 'expense'] += amount;
        months.set(key, sums);
      }
    }

    total += rows.length;

    if (rows.length < BATCH) {
      break;
    }

    after = rows[rows.length - 1].id;
  }

  return {
    taken_at: new Date().toISOString(),
    transactions: total,
    spaces: [...spaces.entries()]
      .sort(([a], [b]) => a - b)
      .map(([spaceId, ledger]) => ({
        space_id: spaceId,
        transactions: ledger.transactions,
        digest: ledger.hash.digest('hex'),
        ...(ledger.owners && { owners: ledger.owners.digest('hex') }),
      })),
    months: byKey(months).map(([, sums]) => ({
      space_id: sums.space_id,
      month: sums.month,
      income: formatMoney(sums.income),
      expense: formatMoney(sums.expense),
      count: sums.count,
    })),
    initial_balances: [...initialBalances.entries()]
      .sort(([a], [b]) => a - b)
      .map(([spaceId, balances]) => ({
        space_id: spaceId,
        count: balances.count,
        amount: formatMoney(balances.amount),
      })),
  };
}

export async function readOwnershipInvariants(dataSource: DataSource): Promise<OwnershipInvariants> {
  const { hasWallets } = await readOwnershipSchema(dataSource);
  const [row]: Record<keyof OwnershipInvariants, string | number | null>[] = await dataSource.query(
    `SELECT
       ${hasWallets ? 'SUM(CASE WHEN w.space_id <> t.space_id THEN 1 ELSE 0 END)' : '0'} AS misplaced,
       SUM(CASE WHEN t.author_user_id IS NULL THEN 1 ELSE 0 END) AS withoutAuthor,
       SUM(CASE WHEN t.assignment_kind <> 'member' AND t.assigned_user_id IS NOT NULL THEN 1 ELSE 0 END)
         AS inconsistentAssignments
     FROM transactions t ${hasWallets ? 'INNER JOIN wallets w ON w.id = t.wallet_id' : ''}`,
  );

  return {
    misplaced: Number(row?.misplaced ?? 0),
    withoutAuthor: Number(row?.withoutAuthor ?? 0),
    inconsistentAssignments: Number(row?.inconsistentAssignments ?? 0),
  };
}

// Every difference between two ledgers, as lines to print; none means the
// history was preserved. Authors and assignments are compared only when both
// ledgers have them.
export function compareLedgers(before: TransactionLedger, after: TransactionLedger): string[] {
  const differences: string[] = [];

  if (before.transactions !== after.transactions) {
    differences.push(`transactions: ${before.transactions} before, ${after.transactions} after`);
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
  const comparesOwners = before.spaces.some((space) => space.owners) && after.spaces.some((space) => space.owners);
  const withoutOwners = (space: SpaceLedger): SpaceLedger => ({
    space_id: space.space_id,
    transactions: space.transactions,
    digest: space.digest,
  });

  compare<SpaceLedger>(
    'space',
    (space) => String(space.space_id),
    comparesOwners ? before.spaces : before.spaces.map(withoutOwners),
    comparesOwners ? after.spaces : after.spaces.map(withoutOwners),
  );
  compare<MonthTotals>('month', (month) => `${month.space_id}/${month.month}`, before.months, after.months);
  compare<InitialBalances>(
    'initial balances of space',
    (balances) => String(balances.space_id),
    before.initial_balances,
    after.initial_balances,
  );

  return differences;
}
