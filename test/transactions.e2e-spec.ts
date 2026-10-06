import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';
import { monthPeriodAt } from '@shared/utils';

describe('Transactions (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let outsider: Member;
  let expenseCategoryId: number;
  let secondExpenseCategoryId: number;
  let incomeCategoryId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'transactions-owner');
    outsider = await createVerifiedMember(testApp, 'transactions-outsider');

    const categories = await api(owner)
      .get(`${base(owner)}/categories`)
      .expect(200);
    expenseCategoryId = categories.body.expenses[0].id;
    secondExpenseCategoryId = categories.body.expenses[1].id;
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

    it('requires If-Match and keeps the record without it', async () => {
      const { wallet } = await createWallet(owner);
      const id = await createTransaction(owner, wallet.id);

      const res = await api(owner)
        .delete(`${base(owner)}/transactions/${id}`)
        .expect(428);

      expect(res.body.code).toBe('TRANSACTION_VERSION_REQUIRED');
      expect(await exists(id)).toBe(true);
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
        .set('If-Match', '"1"')
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
        .set('If-Match', '"1"')
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
          .set('If-Match', '"1"')
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
        .set('If-Match', '"1"')
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

  describe('PATCH /transactions/:id', () => {
    async function setup(initialBalance = '100') {
      const { wallet } = await createWallet(owner, initialBalance);
      const id = await createTransaction(owner, wallet.id);

      return { walletId: wallet.id as number, id };
    }

    function patch(id: string, version: number | null, body: object): request.Test {
      const req = api(owner).patch(`${base(owner)}/transactions/${id}`);
      return (version === null ? req : req.set('If-Match', `"${version}"`)).send(body);
    }

    async function balanceOf(walletId: number): Promise<number> {
      const res = await api(owner)
        .get(`${base(owner)}/wallets`)
        .expect(200);
      return res.body.wallets.find((entry: { wallet: { id: number } }) => entry.wallet.id === walletId).wallet.balance;
    }

    it('changes the amount, bumps the version and returns what GET /:id reads, as the schema describes', async () => {
      const { walletId, id } = await setup();

      const res = await patch(id, 1, { amount: '20' }).expect(200);
      const read = await api(owner)
        .get(`${base(owner)}/transactions/${id}`)
        .expect(200);

      expect(res.body).toEqual({
        transaction: read.body,
        wallets: [{ id: walletId, balance: 80, is_deleted: false }],
      });
      expect(read.body).toEqual(expect.objectContaining({ amount: '20.00', version: 2 }));
      expect(await balanceOf(walletId)).toBe(80);

      const document = createOpenApiDocument(testApp.app);
      expect(
        schemaErrors(document, okResponseSchema(document, '/transactions/{transactionId}', 'patch'), res.body),
      ).toEqual([]);
    });

    it('changes the type together with a matching category, and refuses a mismatch', async () => {
      const { walletId, id } = await setup();

      const mismatch = await patch(id, 1, { transaction_type: 'income' }).expect(400);
      expect(mismatch.body.code).toBe('CATEGORY_TYPE_MISMATCH');

      const res = await patch(id, 1, { transaction_type: 'income', category_id: incomeCategoryId }).expect(200);

      expect(res.body.transaction).toEqual(
        expect.objectContaining({
          transaction_type: 'income',
          category: expect.objectContaining({ id: incomeCategoryId }),
        }),
      );
      expect(await balanceOf(walletId)).toBe(112.3);
    });

    it('moves the transaction between periods and categories in statistics', async () => {
      const { id } = await setup();
      const summary = async (anchor: string) =>
        (
          await api(owner)
            .get(`${base(owner)}/statistics/breakdown`)
            .query({ period: 'month', time_zone: 'UTC', anchor_date: anchor })
            .expect(200)
        ).body;
      const amountOf = (
        block: { by_category: { primary_items: { id: number; amount: string }[] } },
        categoryId: number,
      ) => block.by_category.primary_items.find((item) => item.id === categoryId)?.amount;
      const before = await summary('2026-08-01');

      await patch(id, 1, { timestamp: '2026-08-20T10:00:00.000Z', category_id: secondExpenseCategoryId }).expect(200);

      const after = await summary('2026-08-01');
      const previous = Number(amountOf(before, secondExpenseCategoryId) ?? 0);
      expect(Number(amountOf(after, secondExpenseCategoryId))).toBeCloseTo(previous + 12.3, 2);
    });

    it('moves to another active wallet and returns both balances, the old one first', async () => {
      const { walletId, id } = await setup();
      const { wallet: target } = await createWallet(owner, '50');

      const res = await patch(id, 1, { wallet_id: target.id }).expect(200);

      expect(res.body.wallets).toEqual([
        { id: walletId, balance: 100, is_deleted: false },
        { id: target.id, balance: 37.7, is_deleted: false },
      ]);
      expect(res.body.transaction.wallet).toEqual(expect.objectContaining({ id: target.id }));
      expect(await balanceOf(walletId)).toBe(100);
      expect(await balanceOf(target.id)).toBe(37.7);
    });

    it('refuses moving to a deleted wallet or a wallet of another space', async () => {
      const { id } = await setup();
      const { wallet: deleted } = await createWallet(owner);
      await api(owner)
        .delete(`${base(owner)}/wallets/${deleted.id}`)
        .expect(200);
      const { wallet: foreign } = await createWallet(outsider);

      expect((await patch(id, 1, { wallet_id: deleted.id }).expect(400)).body.code).toBe('WALLET_DELETED');
      expect((await patch(id, 1, { wallet_id: foreign.id }).expect(403)).body.code).toBe('FORBIDDEN_WALLET');
    });

    it('keeps its own deleted wallet and archived category while other fields change', async () => {
      const { wallet } = await createWallet(owner);
      const category = await api(owner)
        .post(`${base(owner)}/categories`)
        .send({ name: 'Fading', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const id = await createTransaction(owner, wallet.id, category.body.id);
      await api(owner)
        .delete(`${base(owner)}/categories/${category.body.id}`)
        .expect(200);
      await api(owner)
        .delete(`${base(owner)}/wallets/${wallet.id}`)
        .expect(200);

      const res = await patch(id, 1, {
        wallet_id: wallet.id,
        category_id: category.body.id,
        description: 'Still here',
      }).expect(200);

      expect(res.body.transaction).toEqual(
        expect.objectContaining({
          description: 'Still here',
          wallet: null,
          category: expect.objectContaining({ id: category.body.id, is_archived: true }),
        }),
      );
      expect(res.body.wallets).toEqual([{ id: wallet.id, balance: -12.3, is_deleted: true }]);
    });

    it('keeps the version when nothing changes', async () => {
      const { id } = await setup();

      const res = await patch(id, 1, {
        amount: '12.30',
        description: ' Lunch ',
        timestamp: '2026-09-15T13:00:00.000+03:00',
      }).expect(200);

      expect(res.body.transaction.version).toBe(1);
    });

    it('keeps a legacy zero amount when another field changes, but refuses setting zero', async () => {
      const { id } = await setup();
      await testApp.dataSource.query('UPDATE transactions SET amount = 0 WHERE id = ?', [id]);

      const res = await patch(id, 1, { amount: '0', description: 'Legacy' }).expect(200);
      expect(res.body.transaction).toEqual(expect.objectContaining({ amount: '0.00', description: 'Legacy' }));

      const zero = await patch(id, 2, { amount: '5' }).expect(200);
      expect(zero.body.transaction.amount).toBe('5.00');
      const refused = await patch(id, 3, { amount: '0' }).expect(400);
      expect(refused.body.message).toEqual([{ field: 'amount', error: 'amount must be greater than 0' }]);
    });

    it('refuses a stale version and a missing If-Match', async () => {
      const { id } = await setup();
      await patch(id, 1, { amount: '20' }).expect(200);

      const stale = await patch(id, 1, { amount: '30' }).expect(409);
      const missing = await patch(id, null, { amount: '30' }).expect(428);

      expect(stale.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      expect(missing.body.code).toBe('TRANSACTION_VERSION_REQUIRED');
    });

    it.each<[string, object]>([
      ['a null wallet', { wallet_id: null }],
      ['an unknown field', { kind: 'regular' }],
      ['a malformed amount', { amount: '1.234' }],
    ])('rejects %s before If-Match and the record are looked at', async (_, body) => {
      const res = await patch('not-a-uuid', null, body).expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses the initial balance', async () => {
      const funded = await createWallet(owner, '25');

      const res = await patch(funded.transaction.id, 1, { amount: '30' }).expect(400);

      expect(res.body.code).toBe('TRANSACTION_IS_SYSTEM');
    });

    it('answers a repeat with the same Idempotency-Key with the original result', async () => {
      const { id } = await setup();
      const send = () => patch(id, 1, { amount: '20' }).set('Idempotency-Key', `patch-${id}`);

      const first = await send().expect(200);
      const repeat = await send().expect(200);

      expect(repeat.body).toEqual(first.body);
      expect(repeat.body.transaction.version).toBe(2);
    });

    it('is not found for a transaction of another space', async () => {
      const { wallet } = await createWallet(outsider);
      const categories = await api(outsider)
        .get(`${base(outsider)}/categories`)
        .expect(200);
      const foreignId = await createTransaction(outsider, wallet.id, categories.body.expenses[0].id);

      const res = await patch(foreignId, 1, { amount: '1' }).expect(404);

      expect(res.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('Undo of a create', () => {
    async function addGuest(): Promise<Member> {
      const guest = await createVerifiedMember(testApp, 'transactions-guest');
      guests.push(guest.userId);
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        owner.spaceId,
        guest.userId,
      ]);
      return guest;
    }

    const guests: number[] = [];

    afterAll(async () => {
      await deleteUsers(testApp.dataSource, guests);
    });

    async function createAsOwner(walletId: number) {
      const res = await api(owner)
        .post(`${base(owner)}/transactions`)
        .send({
          wallet_id: walletId,
          category_id: expenseCategoryId,
          transaction_type: 'expense',
          amount: '12.3',
          timestamp: '2026-09-15T10:00:00.000Z',
        })
        .expect(201);
      return res.body.transaction as { id: string; version: number };
    }

    const undo = (member: Member, transaction: { id: string; version: number }) =>
      api(member)
        .delete(`${base(owner)}/transactions/${transaction.id}`)
        .set('If-Match', `"${transaction.version}"`);

    it('deletes the created record with the version from the POST result', async () => {
      const { wallet } = await createWallet(owner, '100');
      const created = await createAsOwner(wallet.id);

      await undo(owner, created).expect(200);

      const read = await api(owner)
        .get(`${base(owner)}/transactions/${created.id}`)
        .expect(404);
      expect(read.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('refuses to undo a record another member edited meanwhile, and keeps the new version', async () => {
      const { wallet } = await createWallet(owner);
      const created = await createAsOwner(wallet.id);
      const guest = await addGuest();
      await api(guest)
        .patch(`${base(owner)}/transactions/${created.id}`)
        .set('If-Match', '"1"')
        .send({ amount: '99' })
        .expect(200);

      const res = await undo(owner, created).expect(409);

      expect(res.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      const read = await api(owner)
        .get(`${base(owner)}/transactions/${created.id}`)
        .expect(200);
      expect(read.body).toEqual(expect.objectContaining({ amount: '99.00', version: 2 }));
    });

    it('tells a member who lost access from a record that is gone', async () => {
      const { wallet } = await createWallet(owner);
      const guest = await addGuest();
      const created = await createAsOwner(wallet.id);
      await testApp.dataSource.query('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [
        owner.spaceId,
        guest.userId,
      ]);

      const lost = await undo(guest, created).expect(403);
      await undo(owner, created).expect(200);
      const gone = await undo(owner, created).expect(404);

      expect(lost.body.code).toBe('FORBIDDEN_SPACE');
      expect(gone.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('deleting a record of a deleted wallet', () => {
    it('changes history, statistics and limits, but no active wallet balance', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-deleted-wallet');

      try {
        const categories = await api(member)
          .get(`${base(member)}/categories`)
          .expect(200);
        const categoryId = categories.body.expenses[0].id;
        const active = await createWallet(member, '100');
        const doomed = await createWallet(member, '0');
        const now = new Date().toISOString();
        const add = (walletId: number, amount: string) =>
          api(member)
            .post(`${base(member)}/transactions`)
            .send({ wallet_id: walletId, category_id: categoryId, transaction_type: 'expense', amount, timestamp: now })
            .expect(201)
            .then((res) => res.body.transaction.id as string);
        await add(active.wallet.id, '10');
        const doomedId = await add(doomed.wallet.id, '25');
        await api(member)
          .post(`${base(member)}/limits`)
          .send({ amount: '1000' })
          .expect(201);
        await api(member)
          .delete(`${base(member)}/wallets/${doomed.wallet.id}`)
          .expect(200);

        const snapshot = async () => {
          const [wallets, limits, summary, history] = await Promise.all([
            api(member)
              .get(`${base(member)}/wallets`)
              .expect(200),
            api(member)
              .get(`${base(member)}/limits`)
              .expect(200),
            api(member)
              .get(`${base(member)}/statistics/summary`)
              .query({ period: 'month', time_zone: 'UTC' })
              .expect(200),
            api(member)
              .get(`${base(member)}/transactions`)
              .expect(200),
          ]);
          return {
            balances: wallets.body.wallets.map((entry: { wallet: { id: number; balance: number } }) => [
              entry.wallet.id,
              entry.wallet.balance,
            ]),
            total_balance: wallets.body.total_balance,
            spent: limits.body.total.spent,
            expense: summary.body.expense,
            history: history.body.map((row: { id: string }) => row.id),
          };
        };
        const before = await snapshot();

        await api(member)
          .delete(`${base(member)}/transactions/${doomedId}`)
          .set('If-Match', '"1"')
          .expect(200);

        const after = await snapshot();
        expect(after.balances).toEqual(before.balances);
        expect(after.balances).toContainEqual([active.wallet.id, 90]);
        expect(after.balances.map(([id]: [number]) => id)).not.toContain(doomed.wallet.id);
        expect(after.total_balance).toBe(before.total_balance);
        expect([before.spent, after.spent]).toEqual([35, 10]);
        expect([before.expense, after.expense]).toEqual([
          { amount: '35.00', count: 2 },
          { amount: '10.00', count: 1 },
        ]);
        expect(before.history).toContain(doomedId);
        expect(after.history).not.toContain(doomedId);
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });
  });

  describe('history list and count', () => {
    it('orders equal timestamps by id and counts the rows the list returns, initial balance included', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-history');

      try {
        const categories = await api(member)
          .get(`${base(member)}/categories`)
          .expect(200);
        const funded = await createWallet(member, '50');
        const at = new Date(Date.now() - 60_000).toISOString();
        for (let i = 0; i < 3; i++) {
          await api(member)
            .post(`${base(member)}/transactions`)
            .send({
              wallet_id: funded.wallet.id,
              category_id: categories.body.expenses[0].id,
              transaction_type: 'expense',
              amount: '1',
              timestamp: at,
            })
            .expect(201);
        }
        const query = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString() };

        const list = await api(member)
          .get(`${base(member)}/transactions`)
          .query(query)
          .expect(200);
        const count = await api(member)
          .get(`${base(member)}/transactions/count`)
          .query(query)
          .expect(200);
        const expenses = await api(member)
          .get(`${base(member)}/transactions/count`)
          .query({ ...query, transaction_type: 'expense' })
          .expect(200);

        const sameInstant = list.body.filter((row: { timestamp: string }) => row.timestamp === at);
        const ids = sameInstant.map((row: { id: string }) => row.id);
        expect(ids).toEqual([...ids].sort().reverse());
        expect(list.body.some((row: { kind: string }) => row.kind === 'initial_balance')).toBe(true);
        expect(count.body).toEqual({ count: list.body.length });
        expect(list.body).toHaveLength(4);
        expect(expenses.body).toEqual({ count: 3 });

        const document = createOpenApiDocument(testApp.app);
        expect(schemaErrors(document, okResponseSchema(document, '/transactions/count'), count.body)).toEqual([]);
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it('counts only the initial balance of a new wallet as one row, though Income is zero', async () => {
      const member = await createVerifiedMember(testApp, 'transactions-only-initial');

      try {
        await createWallet(member, '10');

        const count = await api(member)
          .get(`${base(member)}/transactions/count`)
          .expect(200);

        expect(count.body).toEqual({ count: 1 });
      } finally {
        await deleteUsers(testApp.dataSource, [member.userId]);
      }
    });

    it.each(['transactions', 'transactions/count'])('rejects from after to on %s', async (path) => {
      const res = await api(owner)
        .get(`${base(owner)}/${path}`)
        .query({ from: '2026-09-02T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' })
        .expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: [{ field: 'from', error: 'from must not be after to' }],
        }),
      );
    });
  });

  describe('derived data after an edit', () => {
    let member: Member;

    beforeEach(async () => {
      member = await createVerifiedMember(testApp, 'transactions-derived');
    });

    afterEach(async () => {
      await deleteUsers(testApp.dataSource, [member.userId]);
    });

    async function expenseCategories(): Promise<{ id: number; transaction_count: number }[]> {
      const res = await api(member)
        .get(`${base(member)}/categories`)
        .expect(200);
      return res.body.expenses;
    }

    function addExpense(walletId: number, categoryId: number, amount: string, timestamp: string) {
      return api(member)
        .post(`${base(member)}/transactions`)
        .send({ wallet_id: walletId, category_id: categoryId, transaction_type: 'expense', amount, timestamp })
        .expect(201)
        .then((res) => res.body.transaction as { id: string; version: number });
    }

    it('counts limits in the month of the requested zone and reports its bounds', async () => {
      const [category] = await expenseCategories();
      const { wallet } = await createWallet(member);
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '1000' })
        .expect(201);
      // the first instant of this month at UTC+14 is always past, and still
      // the previous month at UTC-11 unless that zone's month has not turned yet
      const east = monthPeriodAt(new Date(), 'Pacific/Kiritimati');
      await addExpense(wallet.id, category.id, '10', east.from.toISOString());

      const limitsIn = (timeZone: string) =>
        api(member)
          .get(`${base(member)}/limits`)
          .query({ time_zone: timeZone })
          .expect(200)
          .then((res) => res.body);
      const eastLimits = await limitsIn('Pacific/Kiritimati');
      const westLimits = await limitsIn('Pacific/Pago_Pago');
      const west = monthPeriodAt(new Date(), 'Pacific/Pago_Pago');

      expect(eastLimits.period).toEqual({
        time_zone: 'Pacific/Kiritimati',
        start_date: east.start_date,
        end_date: east.end_date,
        from: east.from.toISOString(),
        to: east.to.toISOString(),
      });
      expect(eastLimits.total.spent).toBe(10);
      expect(westLimits.total.spent).toBe(east.from >= west.from && east.from <= west.to ? 10 : 0);
    });

    it('rejects a fixed offset as the limits zone', async () => {
      const res = await api(member)
        .get(`${base(member)}/limits`)
        .query({ time_zone: '+03:00' })
        .expect(400);

      expect(res.body.message).toEqual([{ field: 'time_zone', error: 'time_zone must be an IANA time zone name' }]);
    });

    it('moves an edited expense across the month boundary in limits, statistics, history and counters', async () => {
      const [first, second] = await expenseCategories();
      const { wallet } = await createWallet(member, '100');
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '1000' })
        .expect(201);
      await api(member)
        .post(`${base(member)}/limits`)
        .send({ amount: '500', category_ids: [first.id] })
        .expect(201);
      const zone = 'Europe/Moscow';
      const month = monthPeriodAt(new Date(), zone);
      const created = await addExpense(wallet.id, first.id, '25', month.from.toISOString());
      // the last millisecond of the previous month in Moscow
      const previousMonthEnd = new Date(month.from.getTime() - 1).toISOString();

      const snapshot = async () => {
        const [limits, summary, history, count, categories, wallets] = await Promise.all([
          api(member)
            .get(`${base(member)}/limits`)
            .query({ time_zone: zone })
            .expect(200),
          api(member)
            .get(`${base(member)}/statistics/summary`)
            .query({ period: 'month', time_zone: zone })
            .expect(200),
          api(member)
            .get(`${base(member)}/transactions`)
            .query({ from: month.from.toISOString(), to: month.to.toISOString(), transaction_type: 'expense' })
            .expect(200),
          api(member)
            .get(`${base(member)}/transactions/count`)
            .query({ from: month.from.toISOString(), to: month.to.toISOString(), transaction_type: 'expense' })
            .expect(200),
          expenseCategories(),
          api(member)
            .get(`${base(member)}/wallets`)
            .expect(200),
        ]);
        const counter = (id: number) => categories.find((category) => category.id === id)?.transaction_count;
        return {
          total: limits.body.total.spent,
          firstLimit: limits.body.categories[0].spent,
          expense: summary.body.expense,
          history: history.body.length,
          count: count.body.count,
          counters: [counter(first.id), counter(second.id)],
          balance: wallets.body.wallets.find((entry: { wallet: { id: number } }) => entry.wallet.id === wallet.id)
            .wallet.balance,
        };
      };

      expect(await snapshot()).toEqual({
        total: 25,
        firstLimit: 25,
        expense: { amount: '25.00', count: 1 },
        history: 1,
        count: 1,
        counters: [1, 0],
        balance: 75,
      });

      await api(member)
        .patch(`${base(member)}/transactions/${created.id}`)
        .set('If-Match', '"1"')
        .send({ timestamp: previousMonthEnd, category_id: second.id, amount: '30' })
        .expect(200);

      expect(await snapshot()).toEqual({
        total: 0,
        firstLimit: 0,
        expense: { amount: '0.00', count: 0 },
        history: 0,
        count: 0,
        counters: [0, 1],
        balance: 70,
      });
    });
  });
});
