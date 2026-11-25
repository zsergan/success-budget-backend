import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { AppModule } from '../app.module';
import { UsersService } from '@modules/users/users.service';
import { CurrenciesService } from '@modules/currencies/currencies.service';
import { SpaceTransactionsService } from '@modules/transactions/space-transactions.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { encodeFeedCursor, selectionDigest } from '@modules/transactions/feed-cursor';
import type { TransactionFeedQueryV2Dto } from '@modules/transactions/dto/transaction-feed-query-v2.dto';
import { TransactionType } from '@shared/enums';

// Dev-only load test of GET /api/v2/.../transactions/feed (docs/feed-performance.md).
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

const DAY_MS = 86_400_000;
const HISTORY_FROM = Date.UTC(2023, 0, 1);
const HISTORY_DAYS = (Date.UTC(2026, 8, 30) - HISTORY_FROM) / DAY_MS + 1;
const BUSY_DAY = '2026-06-15';
const BUSY_DAY_ROWS = 5_000;
const TIE_DAY = '2026-05-01';
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
  const categories: { id: number; transaction_type: string }[] = await dataSource.query(
    'SELECT id, transaction_type FROM categories WHERE space_id = ? AND is_system = 0',
    [spaceId],
  );

  return {
    userId: user.id,
    spaceId,
    expenseIds: categories.filter((c) => c.transaction_type === 'expense').map((c) => c.id),
    incomeIds: categories.filter((c) => c.transaction_type === 'income').map((c) => c.id),
  } satisfies Fixture;
}

async function fill(dataSource: DataSource, fixture: Fixture, count: number, extras: boolean) {
  const rows: unknown[][] = [];
  const row = (date: string) => {
    const income = random() < 0.1;
    const assignment = random();

    rows.push([
      // 60 % the whole space, 25 % the member, 15 % nobody
      assignment < 0.6 ? 'space' : assignment < 0.85 ? 'member' : 'unassigned',
      assignment >= 0.6 && assignment < 0.85 ? fixture.userId : null,
      pick(income ? fixture.incomeIds : fixture.expenseIds),
      income ? 'income' : 'expense',
      (random() * (income ? 3000 : 120)).toFixed(2),
      date,
      random() < 0.15 ? null : `${pick(WORDS)} ${pick(WORDS)} #${Math.floor(random() * 1000)}`,
    ]);
  };

  const regular = extras ? count - BUSY_DAY_ROWS - TIE_ROWS : count;

  for (let i = 0; i < regular; i++) {
    row(new Date(HISTORY_FROM + Math.floor(random() * HISTORY_DAYS) * DAY_MS).toISOString().slice(0, 10));
  }

  if (extras) {
    for (let i = 0; i < BUSY_DAY_ROWS; i++) {
      row(BUSY_DAY);
    }

    for (let i = 0; i < TIE_ROWS; i++) {
      row(TIE_DAY);
    }
  }

  for (let start = 0; start < rows.length; start += 2_000) {
    const batch = rows.slice(start, start + 2_000);
    await dataSource.query(
      'INSERT INTO transactions (id, space_id, author_user_id, author_source, assignment_kind, assigned_user_id, ' +
        'category_id, transaction_type, amount, date, description) VALUES ' +
        batch.map(() => "(UUID(), ?, ?, 'recorded', ?, ?, ?, ?, ?, ?, ?)").join(', '),
      batch.flatMap((values) => [fixture.spaceId, fixture.userId, ...values]),
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
  const feedService = app.get(SpaceTransactionsService);
  const queries = app.get(TransactionQueriesService);

  console.log(`Filling: ${TRANSACTIONS} transactions in the measured space, ${NOISE} in another one...`);
  const fixture = await createSpace(app, 'measured');
  const noise = await createSpace(app, 'noise');
  await fill(dataSource, fixture, TRANSACTIONS, true);
  await fill(dataSource, noise, NOISE, false);
  await dataSource.query('ANALYZE TABLE transactions, categories');

  const [{ total }] = await dataSource.query('SELECT COUNT(*) AS total FROM transactions');
  console.log(`transactions table: ${total} rows\n`);

  const captured: { sql: string; parameters: unknown[] }[] = [];
  const logger = dataSource.logger;
  const logQuery = logger.logQuery.bind(logger);
  logger.logQuery = (sql, parameters, runner) => {
    captured.push({ sql, parameters: Array.isArray(parameters) ? parameters : [] });
    logQuery(sql, parameters, runner);
  };

  const base: TransactionFeedQueryV2Dto = { from_date: '2026-09-01', to_date: '2026-09-30', limit: 50 };
  const all = { from_date: '1000-01-01', to_date: '9999-12-31' };
  const year = { from_date: '2025-01-01', to_date: '2025-12-31' };
  const busyDay = { from_date: BUSY_DAY, to_date: BUSY_DAY };
  const inHistoryOrder =
    'FROM transactions t WHERE t.space_id = ? AND t.date BETWEEN ? AND ? ' +
    'ORDER BY t.date DESC, t.order_key DESC LIMIT 1 OFFSET ?';

  const cursorAt = async (query: TransactionFeedQueryV2Dto, offset: number) => {
    const [row]: { date: string; order_key: string }[] = await dataSource.query(
      `SELECT DATE_FORMAT(t.date, '%Y-%m-%d') AS date, t.order_key ${inHistoryOrder}`,
      [fixture.spaceId, query.from_date, query.to_date, offset],
    );
    const selection = {
      spaceId: fixture.spaceId,
      fromDate: query.from_date,
      toDate: query.to_date,
      filters: { search: query.q },
    };

    return encodeFeedCursor(
      { direction: 'older', position: { date: row.date, orderKey: String(row.order_key) } },
      selectionDigest(selection),
    );
  };
  const idAt = async (fromDate: string, toDate: string, offset: number) =>
    (await dataSource.query(`SELECT t.id ${inHistoryOrder}`, [fixture.spaceId, fromDate, toDate, offset]))[0]
      .id as string;

  const tieQuery = { ...base, from_date: '2026-05-01', to_date: '2026-05-31' };
  const feed = (query: TransactionFeedQueryV2Dto) => () => feedService.getFeed(fixture.userId, fixture.spaceId, query);
  const queryScenarios: [string, TransactionFeedQueryV2Dto][] = [
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
    ['inside 2000 records of one date', { ...tieQuery, cursor: await cursorAt(tieQuery, 1_000) }],
    [
      'all history, around a 2023 record',
      { ...base, ...all, around_id: await idAt(all.from_date, all.to_date, TRANSACTIONS - 500) },
    ],
    [
      'month of a 2023 record, around it',
      {
        ...base,
        from_date: '2023-02-01',
        to_date: '2023-02-28',
        around_id: await idAt('2023-02-01', '2023-02-28', 1_000),
      },
    ],
    ['one day with 5000 records, first page', { ...base, ...busyDay }],
    [
      'one day with 5000 records, around the middle',
      {
        ...base,
        ...busyDay,
        around_id: await idAt(busyDay.from_date, busyDay.to_date, 2_500),
      },
    ],
  ];

  const scenarios: [string, () => Promise<{ summary: { count: number }; items: unknown[] }>][] = [
    ...queryScenarios.map(([name, query]) => [name, feed(query)] as [string, ReturnType<typeof feed>]),
    ['month, unassigned', feed({ ...base, assignment: 'unassigned' })],
    ['year, assigned to the member', feed({ ...base, ...year, assignment: `member:${fixture.userId}` })],
    ['all history, unassigned, home (limit 5)', feed({ ...base, ...all, limit: 5, assignment: 'unassigned' })],
    ['all history, whole space, search "coffee"', feed({ ...base, ...all, q: 'coffee', assignment: 'space' })],
  ];

  const timings: string[] = [];
  const plans: string[] = [];

  for (const [name, read] of scenarios) {
    await read();
    const times: number[] = [];

    for (let run = 0; run < RUNS; run++) {
      captured.length = 0;
      const started = process.hrtime.bigint();
      const result = await read();
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

  for (const [name, period] of [
    ['breakdown by assignment, year', year],
    ['breakdown by assignment, all history', all],
  ] as const) {
    captured.length = 0;
    const started = process.hrtime.bigint();
    await queries.getStatisticsByAssignment(
      fixture.spaceId,
      TransactionType.EXPENSE,
      period.from_date,
      period.to_date,
      dataSource.manager,
    );
    timings.push(`${name}|-|-|${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)}`);
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
      fromDate: query.from_date,
      toDate: query.to_date,
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
      await dataSource.query('DELETE FROM transactions WHERE space_id = ?', [spaceId]);
      await dataSource.query('DELETE FROM idempotency_keys WHERE user_id = ?', [userId]);
      await dataSource.query(
        'DELETE FROM limit_categories WHERE limit_id IN (SELECT id FROM limits WHERE space_id = ?)',
        [spaceId],
      );
      await dataSource.query('DELETE FROM limits WHERE space_id = ?', [spaceId]);
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
