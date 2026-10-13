import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../app.module';
import { UsersService } from '@modules/users/users.service';
import { CurrenciesService } from '@modules/currencies/currencies.service';
import { TransactionsService } from '@modules/transactions/transactions.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { encodeFeedCursor, selectionDigest } from '@modules/transactions/feed-cursor';
import type { TransactionFeedQueryDto } from '@modules/transactions/dto/transaction-feed-query.dto';

// Dev-only load test of GET /transactions/feed (docs/feed-performance.md).
// Fills a disposable database with a large space and a second, unrelated
// one, then times the feed scenarios through the service and prints the
// EXPLAIN ANALYZE of every query they run. Usage:
//   npm run bench:feed -- [--transactions 120000] [--noise 120000] [--runs 7] [--keep]

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const index = args.indexOf(`--${name}`);

  return index === -1 ? fallback : Number(args[index + 1]);
};

const TRANSACTIONS = option('transactions', 120_000);
const NOISE = option('noise', 120_000);
const RUNS = option('runs', 7);
const KEEP = args.includes('--keep');

const HISTORY_FROM = Date.UTC(2023, 0, 1);
const HISTORY_TO = Date.UTC(2026, 8, 30, 23, 59, 59);
const BUSY_DAY = Date.UTC(2026, 5, 15, 9);
const BUSY_DAY_ROWS = 5_000;
const TIE_INSTANT = new Date(Date.UTC(2026, 4, 1, 12));
const TIE_ROWS = 2_000;
const WORDS = [
  'coffee',
  'lunch',
  'taxi',
  'groceries',
  'rent',
  'кофе',
  'обед',
  'такси',
  'gift',
  'book',
  'fuel',
  'pharmacy',
];

// deterministic, so runs compare
let seed = 42;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;

  return seed / 2 ** 31;
};
const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];

interface Fixture {
  userId: number;
  spaceId: number;
  walletIds: number[];
  expenseIds: number[];
  incomeIds: number[];
}

async function createSpace(app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>, label: string) {
  const users = app.get(UsersService);
  const dataSource = app.get(DataSource);
  const [currency] = await app.get(CurrenciesService).getAll();
  const user = await users.register({
    name: `Bench ${label}`,
    email: `bench-${label}-${Date.now()}@bench.local`,
    password: 'DevTest#2026',
    base_currency_id: currency.id,
  });
  await users.completeEmailVerification(user.id);

  const [{ space_id: spaceId }] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [
    user.id,
  ]);
  const walletIds: number[] = [];

  for (const [name, deleted] of [
    ['Card', 0],
    ['Cash', 0],
    ['Savings', 0],
    ['Old card', 1],
  ] as const) {
    const result = await dataSource.query(
      'INSERT INTO wallets (space_id, wallet_name, design, is_deleted, deleted_at) VALUES (?, ?, ?, ?, ?)',
      [spaceId, name, 'slate', deleted, deleted ? new Date() : null],
    );
    walletIds.push(result.insertId);
  }

  const categories: { id: number; transaction_type: string }[] = await dataSource.query(
    'SELECT id, transaction_type FROM categories WHERE space_id = ? AND is_system = 0',
    [spaceId],
  );

  return {
    userId: user.id,
    spaceId,
    walletIds,
    expenseIds: categories.filter((c) => c.transaction_type === 'expense').map((c) => c.id),
    incomeIds: categories.filter((c) => c.transaction_type === 'income').map((c) => c.id),
  } satisfies Fixture;
}

async function fill(dataSource: DataSource, fixture: Fixture, count: number, extras: boolean) {
  const rows: unknown[][] = [];
  const row = (timestamp: Date) => {
    const income = random() < 0.1;

    rows.push([
      pick(fixture.walletIds),
      pick(income ? fixture.incomeIds : fixture.expenseIds),
      income ? 'income' : 'expense',
      (random() * (income ? 3000 : 120)).toFixed(2),
      timestamp,
      random() < 0.15 ? null : `${pick(WORDS)} ${pick(WORDS)} #${Math.floor(random() * 1000)}`,
    ]);
  };

  const regular = extras ? count - BUSY_DAY_ROWS - TIE_ROWS : count;

  for (let i = 0; i < regular; i++) {
    row(new Date(HISTORY_FROM + Math.floor(random() * (HISTORY_TO - HISTORY_FROM))));
  }

  if (extras) {
    for (let i = 0; i < BUSY_DAY_ROWS; i++) {
      row(new Date(BUSY_DAY + Math.floor(random() * 10 * 3_600_000)));
    }

    for (let i = 0; i < TIE_ROWS; i++) {
      row(TIE_INSTANT);
    }
  }

  for (let start = 0; start < rows.length; start += 2_000) {
    const batch = rows.slice(start, start + 2_000);
    await dataSource.query(
      'INSERT INTO transactions (id, wallet_id, category_id, transaction_type, amount, timestamp, description) VALUES ' +
        batch.map(() => '(UUID(), ?, ?, ?, ?, ?, ?)').join(', '),
      batch.flat(),
    );
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function bootstrap() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run the feed benchmark with NODE_ENV=production.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const dataSource = app.get(DataSource);
  const feedService = app.get(TransactionsService);
  const queries = app.get(TransactionQueriesService);

  console.log(`Filling: ${TRANSACTIONS} transactions in the measured space, ${NOISE} in another one...`);
  const fixture = await createSpace(app, 'measured');
  const noise = await createSpace(app, 'noise');
  await fill(dataSource, fixture, TRANSACTIONS, true);
  await fill(dataSource, noise, NOISE, false);
  await dataSource.query('ANALYZE TABLE transactions, wallets, categories');

  const [{ total }] = await dataSource.query('SELECT COUNT(*) AS total FROM transactions');
  console.log(`transactions table: ${total} rows\n`);

  const captured: { sql: string; parameters: unknown[] }[] = [];
  const logger = dataSource.logger;
  const logQuery = logger.logQuery.bind(logger);
  logger.logQuery = (sql, parameters, runner) => {
    captured.push({ sql, parameters: Array.isArray(parameters) ? parameters : [] });
    logQuery(sql, parameters, runner);
  };

  const base: TransactionFeedQueryDto = {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-30T23:59:59.999Z',
    time_zone: 'UTC',
    limit: 50,
  };
  const all = { from: '1970-01-01T00:00:01.000Z', to: '2038-01-19T03:14:07.999Z' };
  const year = { from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T23:59:59.999Z' };
  const busyDay = { from: '2026-06-15T00:00:00.000Z', to: '2026-06-15T23:59:59.999Z' };

  const cursorAt = async (query: TransactionFeedQueryDto, offset: number) => {
    const [row] = await dataSource.query(
      'SELECT t.id, t.timestamp FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id ' +
        'WHERE w.space_id = ? AND t.timestamp BETWEEN ? AND ? ORDER BY t.timestamp DESC, t.id DESC LIMIT 1 OFFSET ?',
      [fixture.spaceId, new Date(query.from), new Date(query.to), offset],
    );
    const selection = {
      spaceId: fixture.spaceId,
      from: new Date(query.from),
      to: new Date(query.to),
      filters: { search: query.q },
    };

    return encodeFeedCursor(
      { direction: 'older', position: { timestamp: row.timestamp, id: row.id } },
      selectionDigest(selection, query.time_zone),
    );
  };
  const idAt = async (from: string, to: string, offset: number) =>
    (
      await dataSource.query(
        'SELECT t.id FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id ' +
          'WHERE w.space_id = ? AND t.timestamp BETWEEN ? AND ? ORDER BY t.timestamp DESC, t.id DESC LIMIT 1 OFFSET ?',
        [fixture.spaceId, new Date(from), new Date(to), offset],
      )
    )[0].id as string;

  const tieQuery = { ...base, from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T23:59:59.999Z' };
  const scenarios: [string, TransactionFeedQueryDto][] = [
    ['month, first page', base],
    ['year, first page', { ...base, ...year }],
    ['all history, home (limit 5)', { ...base, ...all, limit: 5 }],
    [
      'all history, deep page (offset 100000)',
      { ...base, ...all, cursor: await cursorAt({ ...base, ...all }, 100_000) },
    ],
    ['month, search "coffee" (frequent)', { ...base, q: 'coffee' }],
    ['year, search "coffee" (frequent)', { ...base, ...year, q: 'coffee' }],
    ['all history, search "coffee" (frequent)', { ...base, ...all, q: 'coffee' }],
    ['year, search with no match', { ...base, ...year, q: 'zzqx' }],
    ['all history, search with no match', { ...base, ...all, q: 'zzqx' }],
    ['inside 2000 records of one instant', { ...tieQuery, cursor: await cursorAt(tieQuery, 1_000) }],
    [
      'all history, around a 2023 record',
      { ...base, ...all, around_id: await idAt(all.from, all.to, TRANSACTIONS - 500) },
    ],
    [
      'month of a 2023 record, around it',
      {
        ...base,
        from: '2023-02-01T00:00:00.000Z',
        to: '2023-02-28T23:59:59.999Z',
        around_id: await idAt('2023-02-01T00:00:00.000Z', '2023-02-28T23:59:59.999Z', 1_000),
      },
    ],
    ['one day with 5000 records, first page', { ...base, ...busyDay }],
    [
      'one day with 5000 records, around the middle',
      {
        ...base,
        ...busyDay,
        around_id: await idAt(busyDay.from, busyDay.to, 2_500),
      },
    ],
  ];

  const timings: string[] = [];
  const plans: string[] = [];

  for (const [name, query] of scenarios) {
    await feedService.getFeed(fixture.userId, fixture.spaceId, query);
    const times: number[] = [];

    for (let run = 0; run < RUNS; run++) {
      captured.length = 0;
      const started = process.hrtime.bigint();
      const result = await feedService.getFeed(fixture.userId, fixture.spaceId, query);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);

      if (run === 0) {
        timings.push(`${name}|${result.summary.count}|${result.items.length}`);
      }
    }

    timings[timings.length - 1] += `|${median(times).toFixed(1)}`;
    plans.push(`\n## ${name}`);

    for (const { sql, parameters } of captured.filter(({ sql }) => /^SELECT/i.test(sql))) {
      const [explained] = await dataSource.query(`EXPLAIN ANALYZE ${sql}`, parameters);
      plans.push(`\n${sql}\n${Object.values(explained)[0]}`);
    }
  }

  logger.logQuery = logQuery;

  const aggregates: string[] = [];
  for (const [name, query] of [
    ['month', base],
    ['year', { ...base, ...year }],
    ['all history', { ...base, ...all }],
    ['all history, search "coffee"', { ...base, ...all, q: 'coffee' }],
  ] as const) {
    const selection = {
      spaceId: fixture.spaceId,
      from: new Date(query.from),
      to: new Date(query.to),
      filters: { search: 'q' in query ? query.q : undefined },
    };
    const summary: number[] = [];
    const page: number[] = [];

    for (let run = 0; run < RUNS; run++) {
      let started = process.hrtime.bigint();
      await queries.getFeedSummary(selection);
      summary.push(Number(process.hrtime.bigint() - started) / 1e6);

      started = process.hrtime.bigint();
      await queries.getFeedPage(selection, { limit: 50 });
      page.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    aggregates.push(`${name}|${median(page).toFixed(1)}|${median(summary).toFixed(1)}`);
  }

  console.log('scenario|selection|items|median ms');
  timings.forEach((line) => console.log(line));
  console.log('\nselection|page query ms|summary query ms');
  aggregates.forEach((line) => console.log(line));
  console.log('\n# Plans');
  plans.forEach((line) => console.log(line));

  if (!KEEP) {
    for (const { spaceId, userId } of [fixture, noise]) {
      await dataSource.query(
        'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id = ?',
        [spaceId],
      );
      await dataSource.query('DELETE FROM idempotency_keys WHERE user_id = ?', [userId]);
      await dataSource.query(
        'DELETE FROM limit_categories WHERE limit_id IN (SELECT id FROM limits WHERE space_id = ?)',
        [spaceId],
      );
      await dataSource.query('DELETE FROM limits WHERE space_id = ?', [spaceId]);
      await dataSource.query('DELETE FROM wallets WHERE space_id = ?', [spaceId]);
      await dataSource.query('DELETE FROM categories WHERE space_id = ?', [spaceId]);
      await dataSource.query('DELETE FROM space_members WHERE space_id = ?', [spaceId]);
      await dataSource.query('DELETE FROM spaces WHERE id = ?', [spaceId]);
      await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
    }
  }

  await app.close();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
