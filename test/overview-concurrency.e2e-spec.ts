import request from 'supertest';
import { SelectQueryBuilder } from 'typeorm';
import { Category } from '@entities/category.entity';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { pauseAfterFirstCall } from './support/concurrency';

interface Space {
  member: Member;
  walletId: number;
  categoryId: number;
}

interface Pause {
  // settles once the request has reached the held read
  reached: Promise<void>;
  release(): void;
}

// A write commits while GET /wallets or GET /limits is between two of its
// reads. The request is held at the start of its later read until the test
// releases it, so the order is fixed without timers.
describe('Wallet overview and limits under concurrent writes (e2e)', () => {
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
      (method: 'get' | 'post' | 'put') =>
      (path: string): request.Test =>
        agent[method](`${base}${path}`).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), put: withAuth('put') };
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

  async function addExpense({ member, walletId, categoryId }: Space, amount: string): Promise<void> {
    await api(member)
      .post('/transactions')
      .send({
        wallet_id: walletId,
        category_id: categoryId,
        transaction_type: 'expense',
        amount,
        timestamp: new Date(Date.now() - 1000).toISOString(),
      })
      .expect(201);
  }

  function pauseBefore(method: 'getBalances' | 'getExpensesByCategory'): Pause {
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

  // Sends the request and waits until it is held; fails instead of hanging
  // when it finishes without reaching the held read. The response is wrapped:
  // returned bare, it would be awaited here.
  async function startHeld(member: Member, path: string, pause: Pause) {
    const response = api(member)
      .get(path)
      .then((res) => res);

    const finishedEarly = response.then(() => {
      throw new Error(`${path} finished without reaching the held read`);
    });
    finishedEarly.catch(() => undefined);

    await Promise.race([pause.reached, finishedEarly]);

    return { response };
  }

  it('GET /wallets: an expense added between the period totals and the balances is in neither', async () => {
    const space = await createSpace('overview-race');
    await addExpense(space, '100');
    const pause = pauseBefore('getBalances');

    const { response } = await startHeld(space.member, '/wallets', pause);
    await addExpense(space, '50');
    pause.release();
    const res = await response;

    expect(res.status).toBe(200);
    const card = res.body.wallets.find((summary: { wallet: { id: number } }) => summary.wallet.id === space.walletId);
    expect(card).toMatchObject({ wallet: { balance: -100 }, total_spend: 100 });

    const next = await api(space.member).get('/wallets').expect(200);
    const nextCard = next.body.wallets.find(
      (summary: { wallet: { id: number } }) => summary.wallet.id === space.walletId,
    );
    expect(nextCard).toMatchObject({ wallet: { balance: -150 }, total_spend: 150 });
  });

  it('GET /limits: a limit change and an expense between the limits and the spending reads are in neither', async () => {
    const space = await createSpace('limits-race');
    const limit = await api(space.member).post('/limits').send({ amount: '1000' }).expect(201);
    await addExpense(space, '100');
    const pause = pauseBefore('getExpensesByCategory');

    const { response } = await startHeld(space.member, '/limits', pause);
    await api(space.member).put(`/limits/${limit.body.id}`).send({ amount: '500' }).expect(200);
    await addExpense(space, '50');
    pause.release();
    const res = await response;

    expect(res.status).toBe(200);
    expect(res.body.total).toMatchObject({ amount: '1000.00', spent: 100, in_percent: 10 });

    const next = await api(space.member).get('/limits').expect(200);
    expect(next.body.total).toMatchObject({ amount: '500.00', spent: 150, in_percent: 30 });
  });

  it('GET /categories: archival cannot mix an active category with its already-removed limit link', async () => {
    const space = await createSpace('categories-snapshot');
    const limit = await api(space.member)
      .post('/limits')
      .send({ category_ids: [space.categoryId], amount: '100' })
      .expect(201);
    const pause = pauseAfterFirstCall(
      SelectQueryBuilder.prototype,
      'getMany',
      (self) => (self as SelectQueryBuilder<Category>).expressionMap.mainAlias?.target === Category,
    );
    const { response } = await startHeld(space.member, '/categories', pause);
    try {
      await api(space.member).put(`/categories/${space.categoryId}`).send({ is_active: 0 }).expect(200);
    } finally {
      pause.release();
    }
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body.expenses.find((category: { id: number }) => category.id === space.categoryId)).toMatchObject({
      is_active: 1,
      limit: { id: limit.body.id },
    });
    const next = await api(space.member).get('/categories').expect(200);
    expect(next.body.archived.find((category: { id: number }) => category.id === space.categoryId)).toMatchObject({
      is_active: 0,
      limit: null,
    });
  });
});
