import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

const AS_OF = '2026-09-28T12:00:00.000Z';
const MONTH = { period: 'month', time_zone: 'Europe/Moscow', as_of: AS_OF };

interface Space {
  member: Member;
  walletId: number;
  categoryId: number;
}

interface Pause {
  // settles once the block has reached the held read
  reached: Promise<void>;
  release(): void;
}

// Another member writes while a block is between two of its reads. The block
// is held at the start of its second read until the test releases it, so the
// order is fixed without timers.
describe('Statistics blocks under concurrent writes (e2e)', () => {
  let testApp: TestApp;
  let queries: TransactionQueriesService;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
    queries = testApp.app.get(TransactionQueriesService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const base = `/api/v1/spaces/${member.spaceId}`;
    const withAuth =
      (method: 'get' | 'post' | 'delete') =>
      (path: string): request.Test =>
        agent[method](`${base}${path}`).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), delete: withAuth('delete') };
  }

  async function createSpace(prefix: string): Promise<Space> {
    const member = await createVerifiedMember(testApp, prefix);
    userIds.push(member.userId);

    const categories = await api(member).get('/categories').expect(200);
    const wallet = await api(member)
      .post('/wallets')
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);

    return { member, walletId: wallet.body.wallet.id, categoryId: categories.body.expenses[0].id };
  }

  async function addExpense({ member, walletId, categoryId }: Space, amount: string): Promise<string> {
    const res = await api(member)
      .post('/transactions')
      .send({
        wallet_id: walletId,
        category_id: categoryId,
        transaction_type: 'expense',
        amount,
        timestamp: '2026-09-20T10:00:00.000Z',
      })
      .expect(201);

    return res.body.transaction.id;
  }

  function pauseBefore(method: 'getStatisticsByWallet' | 'getLastStatisticsTimestamp'): Pause {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const original = queries[method].bind(queries) as (...args: unknown[]) => Promise<unknown>;

    jest.spyOn(queries, method).mockImplementationOnce((async (...args: unknown[]) => {
      reached();
      await released;

      return original(...args);
    }) as never);

    return { reached: reachedPromise, release };
  }

  // Sends the block request and waits until it is held; fails instead of
  // hanging when the block finishes without reaching the held read. The
  // response is wrapped: returned bare, it would be awaited here.
  async function startHeld(member: Member, block: 'summary' | 'breakdown', pause: Pause) {
    const response = api(member)
      .get(`/statistics/${block}`)
      .query(MONTH)
      .then((res) => res);

    const finishedEarly = response.then(() => {
      throw new Error(`${block} finished without reaching the held read`);
    });
    finishedEarly.catch(() => undefined);

    await Promise.race([pause.reached, finishedEarly]);

    return { response };
  }

  it('breakdown: an expense added between the category and the wallet reads is in neither', async () => {
    const space = await createSpace('statistics-breakdown-race');
    await addExpense(space, '100');
    const pause = pauseBefore('getStatisticsByWallet');

    const { response } = await startHeld(space.member, 'breakdown', pause);
    await addExpense(space, '50');
    pause.release();
    const res = await response;

    expect(res.status).toBe(200);
    expect(res.body.total).toEqual({ amount: '100.00', count: 1 });
    expect(res.body.by_category.total_amount).toBe('100.00');
    expect(res.body.by_wallet.total_amount).toBe('100.00');

    const next = await api(space.member).get('/statistics/breakdown').query(MONTH).expect(200);
    expect(next.body.total).toEqual({ amount: '150.00', count: 2 });
    expect(next.body.by_wallet.total_amount).toBe('150.00');
  });

  it('summary: the last transaction deleted between the totals and the last date reads is still in both', async () => {
    const space = await createSpace('statistics-summary-race');
    const transactionId = await addExpense(space, '100');
    const pause = pauseBefore('getLastStatisticsTimestamp');

    const { response } = await startHeld(space.member, 'summary', pause);
    await api(space.member).delete(`/transactions/${transactionId}`).set('If-Match', '"1"').expect(200);
    pause.release();
    const res = await response;

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expense: { amount: '100.00', count: 1 },
      has_any_transactions: true,
      last_transaction_date: '2026-09-20',
    });

    const next = await api(space.member).get('/statistics/summary').query(MONTH).expect(200);
    expect(next.body).toMatchObject({
      expense: { amount: '0.00', count: 0 },
      has_any_transactions: false,
      last_transaction_date: null,
    });
  });
});
