import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

describe('Transactions (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let expenseCategoryId: number;
  let incomeCategoryId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'transactions-owner');
    outsider = await createVerifiedMember(testApp, 'transactions-outsider');

    const categories = await api(owner)
      .get(`${base(owner)}/categories`)
      .expect(200);
    expenseCategoryId = categories.body.expenses[0].id;
    incomeCategoryId = categories.body.incomes[0].id;
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, outsider?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  function base(member: Member): string {
    return `/api/v1/spaces/${member.spaceId}`;
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), patch: withAuth('patch'), delete: withAuth('delete') };
  }

  async function createWallet(member: Member, initialBalance = '0') {
    const res = await api(member)
      .post(`${base(member)}/wallets`)
      .send({ wallet_name: 'Card', initial_balance: initialBalance, design: 'slate' })
      .expect(201);

    return res.body;
  }

  async function createTransaction(member: Member, walletId: number, categoryId = expenseCategoryId) {
    const res = await api(member)
      .post(`${base(member)}/transactions`)
      .send({
        wallet_id: walletId,
        category_id: categoryId,
        transaction_type: 'expense',
        amount: '12.3',
        timestamp: '2026-09-15T10:00:00.000Z',
        description: 'Lunch',
      })
      .expect(201);

    return res.body.transaction.id as string;
  }

  describe('GET /transactions/:id', () => {
    it('returns the same view as the list, as the OpenAPI schema describes', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      const res = await api(owner)
        .get(`${base(owner)}/transactions/${id}`)
        .expect(200);
      const list = await api(owner)
        .get(`${base(owner)}/transactions?from=2026-09-01&to=2026-09-30`)
        .expect(200);

      expect(res.body).toEqual(list.body.find((item: { id: string }) => item.id === id));
      expect(res.body).toEqual({
        id,
        kind: 'regular',
        transaction_type: 'expense',
        amount: '12.30',
        timestamp: '2026-09-15T10:00:00.000Z',
        description: 'Lunch',
        version: 1,
        wallet: expect.objectContaining({ id: wallet.id, wallet_name: 'Card' }),
        category: expect.objectContaining({ id: expenseCategoryId, is_active: 1, is_archived: false }),
      });

      const document = createOpenApiDocument(testApp.app);
      expect(schemaErrors(document, okResponseSchema(document, '/transactions/{transactionId}'), res.body)).toEqual([]);
    });

    it('reads the initial balance as a system record', async () => {
      const funded = await createWallet(owner, '25');

      const res = await api(owner)
        .get(`${base(owner)}/transactions/${funded.transaction.id}`)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({ kind: 'initial_balance', transaction_type: 'income', amount: '25.00' }),
      );
    });

    it('reads a transaction of a deleted wallet and an archived category', async () => {
      const { wallet } = await createWallet(owner);
      const category = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Short-lived', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const id = await createTransaction(owner, wallet.id, category.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${category.body.id}`)
        .expect(200);
      await api(owner)
        .delete(`${base(owner)}/wallets/${wallet.id}`)
        .expect(200);

      const res = await api(owner)
        .get(`${base(owner)}/transactions/${id}`)
        .expect(200);

      expect(res.body.wallet).toBeNull();
      expect(res.body.category).toEqual(expect.objectContaining({ id: category.body.id, is_archived: true }));
    });

    it('does not reveal a transaction of another space', async () => {
      const { wallet } = await createWallet(outsider);
      const foreignId = await createTransaction(
        outsider,
        wallet.id,
        (
          await api(outsider)
            .get(`${base(outsider)}/categories`)
            .expect(200)
        ).body.expenses[0].id,
      );

      const foreign = await api(owner)
        .get(`${base(owner)}/transactions/${foreignId}`)
        .expect(404);
      const missing = await api(owner)
        .get(`${base(owner)}/transactions/00000000-0000-0000-0000-000000000000`)
        .expect(404);
      const malformed = await api(owner)
        .get(`${base(owner)}/transactions/not-a-uuid`)
        .expect(404);

      for (const res of [foreign, missing, malformed]) {
        expect(res.body).toEqual(
          expect.objectContaining({ statusCode: 404, code: 'TRANSACTION_NOT_FOUND', message: 'Transaction not found' }),
        );
      }
    });

    it('refuses a non-member with the space access error, whatever the transaction', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      for (const transactionId of [id, 'not-a-uuid']) {
        const res = await api(outsider)
          .get(`${base(owner)}/transactions/${transactionId}`)
          .expect(403);

        expect(res.body).toEqual(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN_SPACE' }));
      }
    });

    it('requires authentication', async () => {
      const res = await request(testApp.app.getHttpServer())
        .get(`${base(owner)}/transactions/latest`)
        .expect(401);

      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('DELETE /transactions/:id', () => {
    async function exists(id: string): Promise<boolean> {
      const rows: unknown[] = await testApp.dataSource.query('SELECT id FROM transactions WHERE id = ?', [id]);
      return rows.length > 0;
    }

    it('deletes with the version the client read, and a repeat is not found', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      const res = await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .set('If-Match', '"1"')
        .expect(200);
      expect(res.text).toBe('true');
      expect(await exists(id)).toBe(false);

      const repeat = await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .set('If-Match', '"1"')
        .expect(404);
      expect(repeat.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('still deletes without If-Match', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .expect(200);

      expect(await exists(id)).toBe(false);
    });

    it('refuses a stale version and keeps the record', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);
      await testApp.dataSource.query('UPDATE transactions SET version = 2 WHERE id = ?', [id]);

      const res = await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .set('If-Match', '"1"')
        .expect(409);

      expect(res.body).toEqual(expect.objectContaining({ statusCode: 409, code: 'TRANSACTION_VERSION_CONFLICT' }));
      expect(await exists(id)).toBe(true);
    });

    it('rejects a malformed If-Match before looking the record up', async () => {
      const res = await api(outsider)
        .delete(`${base(owner)}/transactions/not-a-uuid`)
        .set('If-Match', 'W/"1"')
        .expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: [{ field: 'If-Match', error: 'If-Match must be a record version, e.g. "3"' }],
        }),
      );
    });

    it('refuses the initial balance', async () => {
      const funded = await createWallet(owner, '25');

      const res = await api(owner)
        .delete(`${base(owner)}/transactions/${funded.transaction.id}`)
        .expect(400);

      expect(res.body).toEqual(expect.objectContaining({ statusCode: 400, code: 'TRANSACTION_IS_SYSTEM' }));
      expect(await exists(funded.transaction.id)).toBe(true);
    });

    it('deletes a transaction of a deleted wallet', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);
      await api(owner)
        .delete(`${base(owner)}/wallets/${wallet.id}`)
        .expect(200);

      await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .expect(200);

      expect(await exists(id)).toBe(false);
    });

    it('does not reveal or delete a transaction of another space', async () => {
      const { wallet } = await createWallet(outsider);
      const categories = await api(outsider)
        .get(`${base(outsider)}/categories`)
        .expect(200);
      const foreignId = await createTransaction(outsider, wallet.id, categories.body.expenses[0].id);

      for (const id of [foreignId, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
        const res = await api(owner)
          .delete(`${base(owner)}/transactions/${id}`)
          .expect(404);

        expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
      }
      expect(await exists(foreignId)).toBe(true);
    });

    it('refuses a non-member with the space access error', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      const res = await api(outsider)
        .delete(`${base(owner)}/transactions/${id}`)
        .expect(403);

      expect(res.body.code).toBe('FORBIDDEN_SPACE');
      expect(await exists(id)).toBe(true);
    });
  });

  describe('POST /transactions', () => {
    const body = (walletId: number, overrides: Record<string, unknown> = {}) => ({
      wallet_id: walletId,
      category_id: expenseCategoryId,
      transaction_type: 'expense',
      amount: '12.3',
      timestamp: '2026-09-15T10:00:00.000Z',
      ...overrides,
    });

    it('returns the created transaction as GET /:id reads it, with the balance before and after', async () => {
      const { wallet } = await createWallet(owner, '100');

      const res = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(body(wallet.id, { description: '  Lunch  ' }))
        .expect(201);
      const read = await api(owner)
        .get(`${base(owner)}/transactions/${res.body.transaction.id}`)
        .expect(200);

      expect(res.body.transaction).toEqual(read.body);
      expect(res.body.transaction).toEqual(expect.objectContaining({ amount: '12.30', description: 'Lunch' }));
      expect(res.body).toEqual(
        expect.objectContaining({
          previous_balance: 100,
          wallet: expect.objectContaining({ id: wallet.id, balance: 87.7 }),
        }),
      );
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['a zero amount', { amount: '0.00' }, 'amount must be greater than 0'],
      [
        'a timestamp in the future',
        { timestamp: new Date(Date.now() + 10 * 60_000).toISOString() },
        'timestamp must not be in the future',
      ],
      [
        'a description over 140 characters',
        { description: 'x'.repeat(141) },
        'description must be at most 140 characters',
      ],
    ])('refuses %s', async (_, overrides, error) => {
      const { wallet } = await createWallet(owner);

      const res = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(body(wallet.id, overrides))
        .expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({ code: 'VALIDATION_FAILED', message: [{ field: Object.keys(overrides)[0], error }] }),
      );
    });

    it('accepts a timestamp within the clock drift margin and 140 emoji', async () => {
      const { wallet } = await createWallet(owner);

      const res = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(
          body(wallet.id, { timestamp: new Date(Date.now() + 30_000).toISOString(), description: '🙂'.repeat(140) }),
        )
        .expect(201);

      expect([...res.body.transaction.description]).toHaveLength(140);
    });

    it('stores a blank description as null', async () => {
      const { wallet } = await createWallet(owner);

      const res = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(body(wallet.id, { description: '   ' }))
        .expect(201);
      const [row] = await testApp.dataSource.query('SELECT description FROM transactions WHERE id = ?', [
        res.body.transaction.id,
      ]);

      expect(row.description).toBeNull();
    });

    it('refuses a category of the other type and an archived category', async () => {
      const { wallet } = await createWallet(owner);
      const archived = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Old', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      // with history, deleting a category archives it
      await createTransaction(owner, wallet.id, archived.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${archived.body.id}`)
        .expect(200);

      const mismatch = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(body(wallet.id, { category_id: incomeCategoryId }))
        .expect(400);
      const archivedRes = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send(body(wallet.id, { category_id: archived.body.id }))
        .expect(400);

      expect(mismatch.body.code).toBe('CATEGORY_TYPE_MISMATCH');
      expect(archivedRes.body.code).toBe('CATEGORY_ARCHIVED');
    });
  });
});
