import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import {
  type FeedPosition,
  type TransactionSelection,
  TransactionQueriesService,
  searchMatch,
  toSearchPattern,
} from '@modules/transaction-queries/transaction-queries.service';
import { AppColor, CategoryIcon, TransactionKind, TransactionType } from '@shared/enums';
import { createTestApp, createVerifiedMember, deleteUsers, type Member, type TestApp } from './support/app';

// The selection the feed pages and totals share, against MySQL: the search
// depends on collations and LIKE escaping that a mocked query cannot check.
describe('Transaction feed selection (e2e)', () => {
  let testApp: TestApp;
  let queries: TransactionQueriesService;
  let wallets: Repository<Wallet>;
  let categories: Repository<Category>;
  let transactions: Repository<Transaction>;
  let member: Member;

  const from = new Date('2026-10-01T00:00:00.000Z');
  const to = new Date('2026-10-31T23:59:59.999Z');
  const ids: Record<string, string> = {};
  let card: Wallet;
  let cash: Wallet;
  let coffee: Category;
  let salary: Category;
  let archived: Category;

  const selection = (search?: string, extra: TransactionSelection['filters'] = {}): TransactionSelection => ({
    spaceId: member.spaceId,
    from,
    to,
    filters: { ...extra, search },
  });

  // the whole selection as one page
  const select = async (text?: string) => {
    const page = await queries.getFeedPage(selection(text), { limit: 100 });
    expect(page.hasMore).toBe(false);

    return page.items;
  };

  const search = async (text: string) => (await select(text)).map((row) => row.description);

  // the records of the period, newest first, read from the table
  const stored = async (): Promise<string[]> => {
    const rows: { id: string }[] = await testApp.dataSource.query(
      `SELECT transaction.id FROM transactions transaction
         JOIN wallets wallet ON wallet.id = transaction.wallet_id
         WHERE wallet.space_id = ? AND transaction.timestamp BETWEEN ? AND ?
         ORDER BY transaction.timestamp DESC, transaction.id DESC`,
      [member.spaceId, from, to],
    );

    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    testApp = await createTestApp();
    queries = testApp.app.get(TransactionQueriesService);
    wallets = testApp.app.get(getRepositoryToken(Wallet));
    categories = testApp.app.get(getRepositoryToken(Category));
    transactions = testApp.app.get(getRepositoryToken(Transaction));
    member = await createVerifiedMember(testApp, 'feed-selection');

    const category = (name: string, transaction_type: TransactionType, extra: Partial<Category> = {}) =>
      categories.save(
        categories.create({
          space_id: member.spaceId,
          name,
          transaction_type,
          icon: CategoryIcon.OTHER,
          color: AppColor.SLATE,
          is_active: 1,
          sort: 0,
          ...extra,
        }),
      );

    card = await wallets.save(
      wallets.create({ space_id: member.spaceId, wallet_name: 'Card', design: AppColor.SLATE }),
    );
    cash = await wallets.save(
      wallets.create({ space_id: member.spaceId, wallet_name: 'Наличные', design: AppColor.SLATE }),
    );
    coffee = await category('Кофе', TransactionType.EXPENSE);
    salary = await category('Salary', TransactionType.INCOME);
    archived = await category('Old 100%_off!', TransactionType.EXPENSE, { is_active: 0, archived_at: new Date() });
    const system = await categories.findOneByOrFail({ space_id: member.spaceId, is_system: 1 });

    const add = async (
      key: string,
      timestamp: string,
      wallet: Wallet,
      category: Category,
      amount: string,
      description: string | null,
    ) => {
      const saved = await transactions.save(
        transactions.create({
          wallet_id: wallet.id,
          category_id: category.id,
          transaction_type: category.transaction_type,
          amount,
          timestamp: new Date(timestamp),
          description,
        }),
      );
      ids[key] = saved.id;
    };

    await add('initial', '2026-10-01T06:00:00.000Z', card, system, '100.00', null);
    await add('latte', '2026-10-02T08:00:00.000Z', card, coffee, '4.50', 'ЛАТТЕ на вынос');
    await add('tree', '2026-10-03T08:00:00.000Z', card, coffee, '30.00', 'Ёлка');
    await add('cafe', '2026-10-03T08:00:00.000Z', card, coffee, '12.00', 'Café Central');
    await add('percent', '2026-10-03T08:00:00.000Z', card, coffee, '1.00', '100 off');
    await add('literal', '2026-10-04T09:00:00.000Z', card, archived, '2.00', 'a_b 50%! deal');
    await add('salary', '2026-10-05T10:00:00.000Z', card, salary, '2500.00', 'October');
    await add('everywhere', '2026-10-06T11:00:00.000Z', card, coffee, '3.00', 'Card кофе');
    await add('cashOnly', '2026-10-07T12:00:00.000Z', cash, coffee, '7.00', null);
    await add('quote', '2026-10-08T13:00:00.000Z', card, coffee, '1.50', "it's -- fine");
    await add('outside', '2026-11-02T08:00:00.000Z', card, coffee, '9.00', 'Кофе в ноябре');

    await wallets.update(cash.id, { is_deleted: 1, deleted_at: new Date() });
  });

  afterAll(async () => {
    await deleteUsers(testApp.dataSource, [member.userId]);
    await testApp.app.close();
  });

  describe('search', () => {
    it('matches the description, ignoring case, Cyrillic included', async () => {
      expect(await search('латте')).toEqual(['ЛАТТЕ на вынос']);
    });

    it('ignores accents: е finds Ё, e finds é', async () => {
      expect(await search('елка')).toEqual(['Ёлка']);
      expect(await search('CAFE')).toEqual(['Café Central']);
    });

    it('matches the category name, archived categories included', async () => {
      expect(await search('old 100')).toEqual(['a_b 50%! deal']);
    });

    it('matches the stored name of a deleted wallet, which is still read as a deleted wallet', async () => {
      const rows = await select('наличн');

      expect(rows.map((row) => row.id)).toEqual([ids.cashOnly]);
      expect(rows[0].wallet.is_deleted).toBe(1);
    });

    it('matches the system category by its name', async () => {
      const rows = await select('initial');

      expect(rows.map((row) => row.id)).toEqual([ids.initial]);
    });

    it('lists a record matching in several fields once', async () => {
      const rows = await select('card');

      expect(rows.filter((row) => row.id === ids.everywhere)).toHaveLength(1);
      expect(await queries.countForAllWallets(member.spaceId, from, to, { search: 'кофе' })).toBe(
        (await select('кофе')).length,
      );
    });

    it.each([
      ['100%', ['a_b 50%! deal']],
      ['50%!', ['a_b 50%! deal']],
      ['a_b', ['a_b 50%! deal']],
      ['_', ['a_b 50%! deal']],
      ['%', ['a_b 50%! deal']],
      ['!', ['a_b 50%! deal']],
    ])('takes %p literally', async (text, expected) => {
      expect(await search(text)).toEqual(expected);
    });

    it('binds the text as a parameter', async () => {
      expect(await search("it's --")).toEqual(["it's -- fine"]);
      expect(await search("' OR 1=1 --")).toEqual([]);
    });

    it('keeps inner whitespace and treats blank text as no search', async () => {
      expect(await search('на вынос')).toEqual(['ЛАТТЕ на вынос']);
      expect(await search('навынос')).toEqual([]);
      expect(await select('   ')).toHaveLength(10);
    });

    it('combines with the period and the other filters', async () => {
      expect(await search('кофе в ноябре')).toEqual([]);
      expect(
        await queries.countForAllWallets(member.spaceId, from, to, {
          search: 'кофе',
          kind: TransactionKind.REGULAR,
          transactionType: TransactionType.EXPENSE,
          walletId: card.id,
        }),
      ).toBe(6);
    });
  });

  describe('collation', () => {
    // Columns with a binary or a single-byte collation still compare in the
    // search collation, so a column or server setting cannot change matching.
    it.each([
      ['utf8mb4', 'utf8mb4_bin', 'ЁЛКА', 'елк', true],
      ['utf8mb4', 'utf8mb4_bin', 'Café', 'CAFE', true],
      ['utf8mb4', 'utf8mb4_bin', 'Кофе', 'кофи', false],
      ['latin1', 'latin1_bin', 'COFFEE', 'coffee', true],
      ['utf8mb3', 'utf8mb3_bin', 'Наличные', 'НАЛИЧ', true],
    ])('%s %s: %p contains %p is %p', async (charset, collation, value, text, expected) => {
      const [row] = await testApp.dataSource.query(
        `SELECT ${searchMatch('v.value', '?')} AS hit ` +
          `FROM (SELECT CONVERT(? USING ${charset}) COLLATE ${collation} AS value) v`,
        [toSearchPattern(text), value],
      );

      expect(Boolean(Number(row.hit))).toBe(expected);
    });
  });

  describe('pages, totals and positions of one selection', () => {
    const walk = async (sel: TransactionSelection, limit: number) => {
      const seen: string[] = [];
      let after: FeedPosition | undefined;

      for (;;) {
        const page = await queries.getFeedPage(sel, { limit, after });
        seen.push(...page.items.map((row) => row.id));

        if (!page.hasMore) {
          return seen;
        }

        const last = page.items[page.items.length - 1];
        after = { timestamp: last.timestamp, id: last.id };
      }
    };

    it.each([undefined, 'кофе', 'card'])('pages through the rows of the history, search %p', async (text) => {
      const sel = selection(text);
      const matching = new Set((await select(text)).map((row) => row.id));
      const history = (await stored()).filter((id) => matching.has(id));

      expect(await walk(sel, 2)).toEqual(history);
      expect(await walk(sel, 100)).toEqual(history);
    });

    it('reads newer records before a position, newest first', async () => {
      const history = await stored();
      const middle = await transactions.findOneByOrFail({ id: history[5] });

      const page = await queries.getFeedPage(selection(), {
        limit: 3,
        before: { timestamp: middle.timestamp, id: middle.id },
      });

      expect(page.items.map((row) => row.id)).toEqual(history.slice(2, 5));
      expect(page.hasMore).toBe(true);

      const top = await queries.getFeedPage(selection(), {
        limit: 10,
        before: { timestamp: middle.timestamp, id: middle.id },
      });
      expect(top.items.map((row) => row.id)).toEqual(history.slice(0, 5));
      expect(top.hasMore).toBe(false);
    });

    it('orders records of one timestamp by id, descending', async () => {
      const sameInstant = [ids.tree, ids.cafe, ids.percent].sort().reverse();
      const history = await stored();

      expect(history.filter((id) => sameInstant.includes(id))).toEqual(sameInstant);
    });

    it('sums the selection, leaving initial balances out of income and expense', async () => {
      expect(await queries.getFeedSummary(selection())).toEqual({ count: 10, income: 250000n, expense: 6100n });
      expect(await queries.getFeedSummary(selection('кофе'))).toEqual({ count: 7, income: 0n, expense: 5900n });
      expect(await queries.getFeedSummary(selection('initial'))).toEqual({ count: 1, income: 0n, expense: 0n });
      expect(await queries.getFeedSummary(selection('nothing like it'))).toEqual({
        count: 0,
        income: 0n,
        expense: 0n,
      });
    });

    it('nets each interval over the whole selection, initial balances excluded', async () => {
      const day = (date: string) => ({
        from: new Date(`${date}T00:00:00.000Z`),
        to: new Date(`${date}T23:59:59.999Z`),
      });

      expect(
        await queries.getFeedIntervalNets(selection(), [
          day('2026-10-03'),
          day('2026-10-01'),
          day('2026-10-05'),
          day('2026-10-20'),
        ]),
      ).toEqual([-4300n, 0n, 250000n, 0n]);
      expect(await queries.getFeedIntervalNets(selection('café'), [day('2026-10-03')])).toEqual([-1200n]);
      expect(
        await queries.getFeedIntervalNets({ ...selection(), to: new Date('2026-10-03T07:59:59.999Z') }, [
          day('2026-10-03'),
        ]),
      ).toEqual([0n]);
    });

    it('finds the position of a record only inside the selection', async () => {
      const tree = await transactions.findOneByOrFail({ id: ids.tree });

      expect(await queries.findFeedPosition(selection('ёлка'), ids.tree)).toEqual({
        timestamp: tree.timestamp,
        id: ids.tree,
      });
      expect(await queries.findFeedPosition(selection('кафе'), ids.tree)).toBeNull();
      expect(await queries.findFeedPosition(selection(), ids.outside)).toBeNull();
      expect(
        await queries.findFeedPosition(selection(undefined, { kind: TransactionKind.REGULAR }), ids.initial),
      ).toBeNull();
      expect(await queries.findFeedPosition({ ...selection(), spaceId: member.spaceId + 100000 }, ids.tree)).toBeNull();
    });
  });
});
