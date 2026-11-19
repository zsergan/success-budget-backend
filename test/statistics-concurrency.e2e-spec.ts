import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

const AS_OF = '2026-09-28T12:00:00.000Z';
const MONTH = { period: 'month', time_zone: 'Europe/Moscow', as_of: AS_OF };

interface Space {
  member: Member;
  categoryIds: Record<'expense' | 'income', number>;
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

  function api(member: Member, version = 'v2') {
    const agent = request(testApp.app.getHttpServer());
    const base = `/api/${version}/spaces/${member.spaceId}`;
    const withAuth =
      (method: 'get' | 'post' | 'delete') =>
      (path: string): request.Test =>
        agent[method](`${base}${path}`).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), delete: withAuth('delete') };
  }

  async function createSpace(prefix: string): Promise<Space> {
    const member = await createVerifiedMember(testApp, prefix);
    userIds.push(member.userId);

    const categories = await api(member, 'v1').get('/categories').expect(200);

    return {
      member,
      categoryIds: { expense: categories.body.expenses[0].id, income: categories.body.incomes[0].id },
    };
  }

  async function addTransaction(
    { member, categoryIds }: Space,
    amount: string,
    type: 'expense' | 'income' = 'expense',
  ): Promise<string> {
    const res = await api(member)
      .post('/transactions')
      .send({
        category_id: categoryIds[type],
        transaction_type: type,
        amount,
        timestamp: '2026-09-20T10:00:00.000Z',
        assignment: { kind: 'space' },
      })
      .expect(201);

    return res.body.transaction.id;
  }

  function pauseBefore(method: 'getStatisticsByAssignment' | 'getLastStatisticsTimestamp'): Pause {
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
  async function startHeld(member: Member, block: 'summary' | 'breakdown', pause: Pause, query = MONTH) {
    const response = api(member)
      .get(`/statistics/${block}`)
      .query(query)
      .then((res) => res);

    const finishedEarly = response.then(() => {
      throw new Error(`${block} finished without reaching the held read`);
    });
    finishedEarly.catch(() => undefined);

    await Promise.race([pause.reached, finishedEarly]);

    return { response };
  }

  it.each(['expense', 'income'] as const)(
    'breakdown: an %s added between the category and the assignment reads is in neither',
    async (type) => {
      const space = await createSpace(`statistics-breakdown-race-${type}`);
      const query = { ...MONTH, transaction_type: type };
      await addTransaction(space, '100', type);
      const pause = pauseBefore('getStatisticsByAssignment');

      const { response } = await startHeld(space.member, 'breakdown', pause, query);
      await addTransaction(space, '50', type);
      pause.release();
      const res = await response;

      expect(res.status).toBe(200);
      expect(res.body.transaction_type).toBe(type);
      expect(res.body.total).toEqual({ amount: '100.00', count: 1 });
      expect(res.body.by_category.total_amount).toBe('100.00');
      expect(res.body.by_assignment.total_amount).toBe('100.00');

      const next = await api(space.member).get('/statistics/breakdown').query(query).expect(200);
      expect(next.body.total).toEqual({ amount: '150.00', count: 2 });
      expect(next.body.by_assignment.total_amount).toBe('150.00');
    },
  );

  it('summary: the last transaction deleted between the totals and the last date reads is still in both', async () => {
    const space = await createSpace('statistics-summary-race');
    const transactionId = await addTransaction(space, '100');
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
