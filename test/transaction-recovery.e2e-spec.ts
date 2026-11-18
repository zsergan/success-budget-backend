import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { TransactionWrites } from '@modules/transactions/transaction-writes';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';

const INSERT_OPERATION = 'INSERT INTO `transaction_operations`%';

// A write as the installed app keeps it on the device: the v1 body, with
// client_operation_id equal to the Idempotency-Key.
interface StoredCreate {
  spaceId: number;
  idempotencyKey: string;
  data: {
    wallet_id: number;
    category_id: number;
    transaction_type: string;
    amount: string;
    timestamp: string;
    description: string | null;
    client_operation_id: string;
  };
}

// Recovering pending writes of older app builds through v2
// (docs/transactions-v2-contract.md#recovering-writes-across-the-upgrade).
describe('Pending writes across the upgrade (e2e)', () => {
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

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const auth = (test: request.Test) => test.set('Authorization', `Bearer ${member.token}`);

    return {
      get: (url: string) => auth(agent.get(url)),
      post: (url: string) => auth(agent.post(url)),
      put: (url: string) => auth(agent.put(url)),
      patch: (url: string) => auth(agent.patch(url)),
      delete: (url: string) => auth(agent.delete(url)),
    };
  }

  interface Setup {
    owner: Member;
    phone: Member;
    spaceId: number;
    walletId: number;
    categoryId: number;
    otherCategoryId: number;
  }

  // `phone` is the member whose app kept the pending writes
  async function setup(): Promise<Setup> {
    const owner = await createVerifiedMember(testApp, 'recovery-owner');
    const phone = await createVerifiedMember(testApp, 'recovery-phone');
    userIds.push(owner.userId, phone.userId);
    const space = await api(owner)
      .post('/api/v1/spaces')
      .send({ name: 'Family', type: 'group', currency_id: testApp.currencyId })
      .expect(201);
    await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
      space.body.id,
      phone.userId,
    ]);
    const wallet = await api(owner)
      .post(`/api/v1/spaces/${space.body.id}/wallets`)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await api(owner).get(`/api/v1/spaces/${space.body.id}/categories`).expect(200);

    return {
      owner,
      phone,
      spaceId: space.body.id,
      walletId: wallet.body.wallet.id,
      categoryId: categories.body.expenses[0].id,
      otherCategoryId: categories.body.expenses[1].id,
    };
  }

  function storedCreate(s: Setup, amount = '12.30'): StoredCreate {
    const id = randomUUID();

    return {
      spaceId: s.spaceId,
      idempotencyKey: id,
      data: {
        wallet_id: s.walletId,
        category_id: s.categoryId,
        transaction_type: 'expense',
        amount,
        timestamp: '2026-10-08T18:30:00.000Z',
        description: 'Dinner',
        client_operation_id: id,
      },
    };
  }

  // exactly what the old build sends
  const legacyReplay = (member: Member, stored: StoredCreate) =>
    api(member)
      .post(`/api/v1/spaces/${stored.spaceId}/transactions`)
      .set('Idempotency-Key', stored.idempotencyKey)
      .send(stored.data);

  // what the v2 build sends instead: the same id and key, no wallet, the whole space
  const convertedCreate = (member: Member, stored: StoredCreate, overrides: object = {}) =>
    api(member)
      .post(`/api/v2/spaces/${stored.spaceId}/transactions`)
      .set('Idempotency-Key', stored.idempotencyKey)
      .send({ ...stored.data, wallet_id: undefined, assignment: { kind: 'space' }, ...overrides });

  const lookUp = (member: Member, stored: StoredCreate) =>
    api(member).get(`/api/v2/spaces/${stored.spaceId}/transactions/operations/${stored.idempotencyKey}`);

  async function recordsOf(stored: StoredCreate): Promise<number> {
    const [row] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS count FROM transactions WHERE space_id = ? AND description = ?',
      [stored.spaceId, stored.data.description],
    );
    return Number(row.count);
  }

  describe('a pending create', () => {
    it('never sent: absent, then created once by the converted request, as the user for the whole space', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await lookUp(s.phone, stored).expect(404);

      const created = await convertedCreate(s.phone, stored).expect(201);
      const repeat = await convertedCreate(s.phone, stored).expect(201);

      expect(created.body.transaction).toEqual(
        expect.objectContaining({
          amount: '12.30',
          author: expect.objectContaining({ user_id: s.phone.userId, source: 'recorded' }),
          assignment: expect.objectContaining({ kind: 'space' }),
        }),
      );
      expect(repeat.body).toEqual(created.body);
      const found = await lookUp(s.phone, stored).expect(200);
      expect(found.body).toEqual(
        expect.objectContaining({ status: 'applied', transaction_id: created.body.transaction.id }),
      );
      expect(await recordsOf(stored)).toBe(1);
    });

    it('sent but unanswered: found applied, and a converted resend creates nothing', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const original = await legacyReplay(s.phone, stored).expect(201);

      const found = await lookUp(s.phone, stored).expect(200);
      const resent = await convertedCreate(s.phone, stored).expect(409);

      expect(found.body).toEqual(
        expect.objectContaining({
          status: 'applied',
          transaction: expect.objectContaining({
            id: original.body.transaction.id,
            author: expect.objectContaining({ user_id: s.phone.userId, source: 'recorded' }),
          }),
        }),
      );
      expect(found.body.transaction).not.toHaveProperty('wallet');
      expect(resent.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
      expect(await recordsOf(stored)).toBe(1);
    });

    it('applied and deleted since: reported deleted and never created again', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const original = await legacyReplay(s.phone, stored).expect(201);
      await api(s.owner)
        .delete(`/api/v2/spaces/${s.spaceId}/transactions/${original.body.transaction.id}`)
        .set('If-Match', '1')
        .expect(200);

      const found = await lookUp(s.phone, stored).expect(200);
      await convertedCreate(s.phone, stored).expect(409);

      expect(found.body).toEqual(expect.objectContaining({ status: 'deleted', transaction: null }));
      expect(await recordsOf(stored)).toBe(0);
    });

    it('rejected: stays absent, and the restored draft is sent again with the same id', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await testApp.dataSource.query('UPDATE categories SET is_active = 0, archived_at = NOW() WHERE id = ?', [
        s.categoryId,
      ]);

      const refused = await convertedCreate(s.phone, stored).expect(400);
      await lookUp(s.phone, stored).expect(404);
      // a refusal stores no result, so the fixed draft keeps its id and key
      const fixed = await convertedCreate(s.phone, stored, { category_id: s.otherCategoryId }).expect(201);

      expect(refused.body.code).toBe('CATEGORY_ARCHIVED');
      expect((await lookUp(s.phone, stored).expect(200)).body.transaction_id).toBe(fixed.body.transaction.id);
      expect(await recordsOf(stored)).toBe(1);
    });

    it('a changed body under the same key is refused; the lookup still decides', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await convertedCreate(s.phone, stored).expect(201);

      const changed = await convertedCreate(s.phone, stored, { amount: '99.00' }).expect(409);

      expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await lookUp(s.phone, stored).expect(200)).body.transaction.amount).toBe('12.30');
    });

    it('after the key expired, neither a legacy replay nor a converted resend creates it twice', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await legacyReplay(s.phone, stored).expect(201);
      await testApp.dataSource.query('DELETE FROM idempotency_keys WHERE user_id = ? AND idempotency_key = ?', [
        s.phone.userId,
        stored.idempotencyKey,
      ]);

      const replayed = await legacyReplay(s.phone, stored).expect(409);
      const converted = await convertedCreate(s.phone, stored).expect(409);

      expect([replayed.body.code, converted.body.code]).toEqual([
        'TRANSACTION_OPERATION_EXISTS',
        'TRANSACTION_OPERATION_EXISTS',
      ]);
      await lookUp(s.phone, stored).expect(200);
      expect(await recordsOf(stored)).toBe(1);
    });

    it('an original still in flight and its converted retry: one commits, the other is refused', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const checkpoint = pauseAfterFirstCall(testApp.app.get(TransactionWrites), 'recordOperation');

      const [original, retry] = await overlap(
        testApp.dataSource,
        checkpoint,
        INSERT_OPERATION,
        () => legacyReplay(s.phone, stored),
        () => convertedCreate(s.phone, stored),
      );

      expect(original.status).toBe(201);
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
      expect(await recordsOf(stored)).toBe(1);
    });

    it('lost membership: the lookup and the resend are refused as access lost', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await api(s.owner).delete(`/api/v1/spaces/${s.spaceId}/members/${s.phone.userId}`).expect(200);

      const found = await lookUp(s.phone, stored).expect(403);
      const resent = await convertedCreate(s.phone, stored).expect(403);

      expect([found.body.code, resent.body.code]).toEqual(['FORBIDDEN_SPACE', 'FORBIDDEN_SPACE']);
    });
  });

  describe('retired v1 writes', () => {
    const retire = () => {
      const configService = testApp.app.get(ConfigService);
      const get = configService.get.bind(configService);

      jest
        .spyOn(configService, 'get')
        .mockImplementation(((key: string, options?: unknown) =>
          key === 'LEGACY_WRITES' ? 'retired' : get(key, options as never)) as never);
    };

    it('refuses an old request without writing, while v1 reads and the converted request work', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const before = await api(s.phone).post(`/api/v1/spaces/${s.spaceId}/transactions`).send(stored.data);
      retire();

      const legacy = await legacyReplay(s.phone, { ...stored, idempotencyKey: randomUUID() }).expect(410);
      const transactionId = before.body.transaction.id;
      await api(s.phone)
        .patch(`/api/v1/spaces/${s.spaceId}/transactions/${transactionId}`)
        .set('If-Match', '1')
        .send({ amount: '1' })
        .expect(410);
      await api(s.phone)
        .delete(`/api/v1/spaces/${s.spaceId}/transactions/${transactionId}`)
        .set('If-Match', '1')
        .expect(410);
      await api(s.phone)
        .post(`/api/v1/spaces/${s.spaceId}/wallets`)
        .send({ wallet_name: 'New', initial_balance: '0', design: 'slate' })
        .expect(410);
      await api(s.phone).get(`/api/v1/spaces/${s.spaceId}/transactions/${transactionId}`).expect(200);
      await api(s.phone).get(`/api/v1/spaces/${s.spaceId}/wallets`).expect(200);

      expect(legacy.body).toEqual(expect.objectContaining({ statusCode: 410, code: 'LEGACY_API_RETIRED' }));

      const other = storedCreate(s, '7.00');
      await lookUp(s.phone, other).expect(404);
      await convertedCreate(s.phone, other).expect(201);
      await lookUp(s.phone, other).expect(200);
    });
  });

  describe('a pending edit or delete', () => {
    async function created(s: Setup) {
      const stored = storedCreate(s);
      const response = await legacyReplay(s.phone, stored).expect(201);

      return `/api/v2/spaces/${s.spaceId}/transactions/${response.body.transaction.id}`;
    }

    it('applies a stored edit through v2 once, and refuses it after another edit', async () => {
      const s = await setup();
      const path = await created(s);
      const key = randomUUID();

      const applied = await api(s.phone)
        .patch(path)
        .set('If-Match', '1')
        .set('Idempotency-Key', key)
        .send({ amount: '20' })
        .expect(200);
      const repeated = await api(s.phone)
        .patch(path)
        .set('If-Match', '1')
        .set('Idempotency-Key', key)
        .send({ amount: '20' })
        .expect(200);
      const stale = await api(s.phone).patch(path).set('If-Match', '1').send({ amount: '21' }).expect(409);

      expect(repeated.body).toEqual(applied.body);
      expect(stale.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
    });

    it('refuses the wallet of a stored edit, which the client drops', async () => {
      const s = await setup();
      const path = await created(s);

      const refused = await api(s.phone).patch(path).set('If-Match', '1').send({ wallet_id: s.walletId }).expect(400);

      expect(refused.body.message).toEqual([expect.objectContaining({ field: 'wallet_id' })]);
    });

    it('resolves a stored delete: done, then already gone', async () => {
      const s = await setup();
      const path = await created(s);

      await api(s.phone).delete(path).set('If-Match', '1').expect(200);
      const gone = await api(s.phone).delete(path).set('If-Match', '1').expect(404);

      expect(gone.body.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });
});
