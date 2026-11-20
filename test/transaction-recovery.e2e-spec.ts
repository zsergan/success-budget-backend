import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { TransactionWrites } from '@modules/transactions/transaction-writes';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';

const INSERT_OPERATION = 'INSERT INTO `transaction_operations`%';

// A write as the older app build keeps it on the device: the v1 body, with
// client_operation_id equal to the Idempotency-Key. Its wallet no longer exists.
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

// Recovering pending writes of older app builds through v2 once wallets and
// the v1 routes are gone (docs/transactions-v2-contract.md#recovering-writes-across-the-upgrade).
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
    const categories = await api(owner).get(`/api/v1/spaces/${space.body.id}/categories`).expect(200);

    return {
      owner,
      phone,
      spaceId: space.body.id,
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
        wallet_id: 7,
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

  // a create the old build committed before the upgrade, as Release A stored
  // it: the record, by the caller for the whole space, and its operation
  async function committedBeforeUpgrade(member: Member, stored: StoredCreate): Promise<string> {
    const id = randomUUID();
    await testApp.dataSource.query(
      `INSERT INTO transactions (id, space_id, category_id, transaction_type, amount, timestamp, description,
         version, author_user_id, author_source, assignment_kind, assigned_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'recorded', 'space', NULL)`,
      [
        id,
        stored.spaceId,
        stored.data.category_id,
        stored.data.transaction_type,
        stored.data.amount,
        new Date(stored.data.timestamp),
        stored.data.description,
        member.userId,
      ],
    );
    await testApp.dataSource.query(
      `INSERT INTO transaction_operations (space_id, operation_id, transaction_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [stored.spaceId, stored.data.client_operation_id, id, new Date()],
    );

    return id;
  }

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

    it('committed before the upgrade, unanswered: found applied, and a converted resend creates nothing', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const id = await committedBeforeUpgrade(s.phone, stored);

      const found = await lookUp(s.phone, stored).expect(200);
      const resent = await convertedCreate(s.phone, stored).expect(409);

      expect(found.body).toEqual(
        expect.objectContaining({
          status: 'applied',
          transaction: expect.objectContaining({
            id,
            author: expect.objectContaining({ user_id: s.phone.userId, source: 'recorded' }),
          }),
        }),
      );
      expect(found.body.transaction).not.toHaveProperty('wallet');
      expect(resent.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
      expect(await recordsOf(stored)).toBe(1);
    });

    it('committed and deleted since: reported deleted and never created again', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const id = await committedBeforeUpgrade(s.phone, stored);
      await api(s.owner).delete(`/api/v2/spaces/${s.spaceId}/transactions/${id}`).set('If-Match', '1').expect(200);

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

    it('a legacy replay is refused as retired and writes nothing; the converted resend still finds it', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      await committedBeforeUpgrade(s.phone, stored);

      const replayed = await legacyReplay(s.phone, stored).expect(410);
      const converted = await convertedCreate(s.phone, stored).expect(409);

      expect([replayed.body.code, converted.body.code]).toEqual(['LEGACY_API_RETIRED', 'TRANSACTION_OPERATION_EXISTS']);
      await lookUp(s.phone, stored).expect(200);
      expect(await recordsOf(stored)).toBe(1);
    });

    it('two converted resends at once, one without the key: one commits, the other is refused', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const checkpoint = pauseAfterFirstCall(testApp.app.get(TransactionWrites), 'recordOperation');

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        INSERT_OPERATION,
        () => convertedCreate(s.phone, stored),
        () =>
          api(s.phone)
            .post(`/api/v2/spaces/${stored.spaceId}/transactions`)
            .send({ ...stored.data, wallet_id: undefined, assignment: { kind: 'space' } }),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('TRANSACTION_OPERATION_EXISTS');
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

  describe('the retired v1 routes', () => {
    it('answer every transaction, statistics and wallet request with 410 and write nothing', async () => {
      const s = await setup();
      const stored = storedCreate(s);
      const id = await committedBeforeUpgrade(s.phone, stored);
      const v1 = `/api/v1/spaces/${s.spaceId}`;
      const month = 'period=month&time_zone=UTC';

      const responses = [
        await legacyReplay(s.phone, { ...stored, idempotencyKey: randomUUID() }),
        await api(s.phone).patch(`${v1}/transactions/${id}`).set('If-Match', '1').send({ amount: '1' }),
        await api(s.phone).delete(`${v1}/transactions/${id}`).set('If-Match', '1'),
        await api(s.phone).get(`${v1}/transactions/${id}`),
        await api(s.phone).get(`${v1}/transactions/feed?from=2026-10-01T00:00:00Z&to=2026-10-31T00:00:00Z`),
        await api(s.phone).get(`${v1}/transactions/operations/${stored.idempotencyKey}`),
        await api(s.phone).get(`${v1}/statistics/summary?${month}`),
        await api(s.phone).get(`${v1}/statistics/breakdown?${month}`),
        await api(s.phone).get(`${v1}/wallets`),
        await api(s.phone).post(`${v1}/wallets`).send({ wallet_name: 'New', initial_balance: '0', design: 'slate' }),
        await api(s.phone).put(`${v1}/wallets/7`).send({ wallet_name: 'Renamed' }),
        await api(s.phone).delete(`${v1}/wallets/7`),
      ];

      for (const response of responses) {
        expect([response.status, response.body.code]).toEqual([410, 'LEGACY_API_RETIRED']);
      }
      expect(await recordsOf(stored)).toBe(1);
      expect((await lookUp(s.phone, stored).expect(200)).body.transaction).toMatchObject({
        amount: '12.30',
        version: 1,
      });
    });

    it('still answer an unauthenticated request with 401', async () => {
      const s = await setup();

      await request(testApp.app.getHttpServer()).get(`/api/v1/spaces/${s.spaceId}/wallets`).expect(401);
    });
  });

  describe('a pending edit or delete', () => {
    async function created(s: Setup) {
      const id = await committedBeforeUpgrade(s.phone, storedCreate(s));

      return `/api/v2/spaces/${s.spaceId}/transactions/${id}`;
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

      const refused = await api(s.phone).patch(path).set('If-Match', '1').send({ wallet_id: 7 }).expect(400);

      expect(refused.body.message).toEqual([expect.objectContaining({ field: 'wallet_id' })]);
      expect((await api(s.phone).get(path).expect(200)).body.version).toBe(1);
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
