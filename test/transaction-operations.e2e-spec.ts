import { randomUUID } from 'crypto';
import request from 'supertest';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

const RECORD_OPERATION = 'INSERT INTO `transaction_operations`%';

// Recovering a create whose response the client never got, also long after
// its Idempotency-Key expired.
describe('Transaction operations (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
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

  interface Setup {
    member: Member;
    walletId: number;
    categoryId: number;
  }

  async function setup(): Promise<Setup> {
    const member = await createVerifiedMember(testApp, 'tx-operations');
    userIds.push(member.userId);
    const wallet = await api(member)
      .post('/wallets')
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await api(member).get('/categories').expect(200);

    return { member, walletId: wallet.body.wallet.id, categoryId: categories.body.expenses[0].id };
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'patch' | 'delete') =>
      (path: string): request.Test =>
        agent[method](`/api/v1/spaces/${member.spaceId}${path}`).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), patch: withAuth('patch'), delete: withAuth('delete') };
  }

  const expense = ({ walletId, categoryId }: Setup, operationId: string, amount = '12.30') => ({
    wallet_id: walletId,
    category_id: categoryId,
    transaction_type: 'expense',
    amount,
    timestamp: '2026-09-15T10:00:00.000Z',
    client_operation_id: operationId,
  });

  function create(s: Setup, body: object, key?: string): request.Test {
    const req = api(s.member).post('/transactions');

    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  }

  function lookup(s: Setup, operationId: string): request.Test {
    return api(s.member).get(`/transactions/operations/${operationId}`);
  }

  async function expireKeys(userId: number): Promise<void> {
    await testApp.dataSource.query('UPDATE idempotency_keys SET expires_at = ? WHERE user_id = ?', [
      new Date(Date.now() - 1000),
      userId,
    ]);
  }

  async function transactionCount(walletId: number): Promise<number> {
    const [row] = await testApp.dataSource.query('SELECT COUNT(*) AS count FROM transactions WHERE wallet_id = ?', [
      walletId,
    ]);
    return Number(row.count);
  }

  it('reports an applied create with the record the POST returned', async () => {
    const s = await setup();
    const operationId = randomUUID();
    const created = await create(s, expense(s, operationId)).expect(201);

    const res = await lookup(s, operationId.toUpperCase()).expect(200);

    expect(res.body).toEqual({
      operation_id: operationId,
      status: 'applied',
      transaction_id: created.body.transaction.id,
      created_at: expect.any(String),
      deleted_at: null,
      transaction: created.body.transaction,
    });
    const document = createOpenApiDocument(testApp.app);
    const schema = okResponseSchema(document, '/transactions/operations/{operationId}');
    expect(schemaErrors(document, schema, res.body)).toEqual([]);
  });

  it('refuses a retry after the key expired instead of creating a second transaction', async () => {
    const s = await setup();
    const operationId = randomUUID();
    const first = await create(s, expense(s, operationId), operationId).expect(201);

    const replay = await create(s, expense(s, operationId), operationId).expect(201);
    expect(replay.body).toEqual(first.body);

    await expireKeys(s.member.userId);
    const late = await create(s, expense(s, operationId), operationId).expect(409);
    const withoutKey = await create(s, expense(s, operationId)).expect(409);

    expect(late.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
    expect(withoutKey.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
    expect(await transactionCount(s.walletId)).toBe(1);
  });

  it('refuses a late retry as already created even when its wallet was deleted since', async () => {
    const s = await setup();
    const operationId = randomUUID();
    await create(s, expense(s, operationId)).expect(201);
    await api(s.member).delete(`/wallets/${s.walletId}`).expect(200);

    const res = await create(s, expense(s, operationId)).expect(409);

    expect(res.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
  });

  it('reports the current state of a create edited since', async () => {
    const s = await setup();
    const operationId = randomUUID();
    const created = await create(s, expense(s, operationId)).expect(201);
    await api(s.member)
      .patch(`/transactions/${created.body.transaction.id}`)
      .set('If-Match', '"1"')
      .send({ amount: '20' })
      .expect(200);

    const res = await lookup(s, operationId).expect(200);

    expect(res.body).toMatchObject({ status: 'applied', transaction: { amount: '20.00', version: 2 } });
  });

  it('reports a create deleted since, and still refuses to create it again', async () => {
    const s = await setup();
    const operationId = randomUUID();
    const created = await create(s, expense(s, operationId)).expect(201);
    await api(s.member).delete(`/transactions/${created.body.transaction.id}`).set('If-Match', '"1"').expect(200);

    const res = await lookup(s, operationId).expect(200);
    await create(s, expense(s, operationId)).expect(409);

    expect(res.body).toEqual({
      operation_id: operationId,
      status: 'deleted',
      transaction_id: created.body.transaction.id,
      created_at: expect.any(String),
      deleted_at: expect.any(String),
      transaction: null,
    });
    const document = createOpenApiDocument(testApp.app);
    const schema = okResponseSchema(document, '/transactions/operations/{operationId}');
    expect(schemaErrors(document, schema, res.body)).toEqual([]);
    expect(await transactionCount(s.walletId)).toBe(0);
  });

  it('reports a refused create as not found, and lets the same operation be sent again', async () => {
    const s = await setup();
    const operationId = randomUUID();
    await create(s, { ...expense(s, operationId), category_id: 2147483647 }).expect(403);

    const res = await lookup(s, operationId).expect(404);
    await create(s, expense(s, operationId)).expect(201);

    expect(res.body.code).toBe('TRANSACTION_OPERATION_NOT_FOUND');
    await lookup(s, operationId).expect(200);
  });

  it('scopes an operation id to its space', async () => {
    const a = await setup();
    const b = await setup();
    const operationId = randomUUID();
    await create(a, expense(a, operationId)).expect(201);

    await lookup(b, operationId).expect(404);
    await create(b, expense(b, operationId)).expect(201);
  });

  it('is not found for an id that is not a UUID', async () => {
    const s = await setup();

    const res = await lookup(s, 'not-a-uuid').expect(404);

    expect(res.body.code).toBe('TRANSACTION_OPERATION_NOT_FOUND');
  });

  it('refuses a malformed client_operation_id', async () => {
    const s = await setup();

    const res = await create(s, expense(s, 'not-a-uuid')).expect(400);

    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('creates one transaction for two concurrent creates of one operation on different wallets', async () => {
    const s = await setup();
    const other = await api(s.member)
      .post('/wallets')
      .send({ wallet_name: 'Other', initial_balance: '0', design: 'slate' })
      .expect(201);
    const operationId = randomUUID();
    // held after recording the operation, before the commit
    const insideWrite = (_self: unknown, args: unknown[]) => args.length === 3 && args[2] !== undefined;
    const checkpoint = pauseAfterFirstCall(testApp.app.get(TransactionQueriesService), 'getOneInSpace', insideWrite);

    const [first, second] = await overlap(
      testApp.dataSource,
      checkpoint,
      RECORD_OPERATION,
      () => create(s, expense(s, operationId)),
      () => create(s, { ...expense(s, operationId), wallet_id: other.body.wallet.id }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
    expect(await transactionCount(s.walletId)).toBe(1);
    expect(await transactionCount(other.body.wallet.id)).toBe(0);
  });
});
