import request from 'supertest';

import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyKeyPurger } from '@modules/idempotency/idempotency-key-purger';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { LOCK_MEMBERS, LOCK_SPACE, overlap, pauseAfterFirstCall } from './support/concurrency';

const LOCK_TRANSACTION = '%FROM `transactions` `row`%FOR UPDATE%';
const CLAIM_KEY = 'INSERT INTO `idempotency_keys`%';

describe('Transaction writes (e2e)', () => {
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
    categoryId: number;
  }

  async function setup(): Promise<Setup> {
    const member = await createVerifiedMember(testApp, 'tx-writes');
    userIds.push(member.userId);
    const categories = await api(member)
      .get(`${base(member)}/categories`)
      .expect(200);

    return { member, categoryId: categories.body.expenses[0].id };
  }

  function base(member: Member, spaceId = member.spaceId): string {
    return `/api/v1/spaces/${spaceId}`;
  }

  function transactions(member: Member, spaceId = member.spaceId): string {
    return `/api/v2/spaces/${spaceId}/transactions`;
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return {
      get: withAuth('get'),
      post: withAuth('post'),
      put: withAuth('put'),
      patch: withAuth('patch'),
      delete: withAuth('delete'),
    };
  }

  const expense = ({ categoryId }: Setup, amount = '12.30') => ({
    category_id: categoryId,
    transaction_type: 'expense',
    amount,
    date: '2026-09-15',
    time_zone: 'UTC',
    assignment: { kind: 'space' },
  });

  function createWithKey(member: Member, key: string, body: object, spaceId = member.spaceId): request.Test {
    return api(member)
      .post(`${transactions(member, spaceId)}`)
      .set('Idempotency-Key', key)
      .send(body);
  }

  async function transactionCount(spaceId: number): Promise<number> {
    const [row] = await testApp.dataSource.query('SELECT COUNT(*) AS count FROM transactions WHERE space_id = ?', [
      spaceId,
    ]);
    return Number(row.count);
  }

  const queries = () => testApp.app.get(TransactionQueriesService);
  // the write path passes its manager; plain reads do not
  const insideWrite = (_self: unknown, args: unknown[]) => args[args.length - 1] !== undefined && args.length > 1;

  describe('Idempotency-Key', () => {
    it('answers a repeated create with the original result and creates one transaction', async () => {
      const s = await setup();

      const first = await createWithKey(s.member, 'create-1', expense(s)).expect(201);
      const repeat = await createWithKey(s.member, 'create-1', expense(s)).expect(201);

      expect(repeat.body).toEqual(first.body);
      expect(await transactionCount(s.member.spaceId)).toBe(1);
    });

    it('refuses the same key with a different request', async () => {
      const s = await setup();
      await createWithKey(s.member, 'create-2', expense(s)).expect(201);

      const res = await createWithKey(s.member, 'create-2', expense(s, '99.00')).expect(409);

      expect(res.body).toEqual(expect.objectContaining({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' }));
      expect(await transactionCount(s.member.spaceId)).toBe(1);
    });

    it('scopes a key to its user and space and to its operation', async () => {
      const a = await setup();
      const b = await setup();

      await createWithKey(a.member, 'shared-key', expense(a)).expect(201);
      await createWithKey(b.member, 'shared-key', expense(b)).expect(201);
      const created = await createWithKey(a.member, 'other-key', expense(a)).expect(201);
      await api(a.member)
        .delete(`${transactions(a.member)}/${created.body.transaction.id}`)
        .set('If-Match', '"1"')
        .set('Idempotency-Key', 'shared-key')
        .expect(200);

      expect(await transactionCount(a.member.spaceId)).toBe(1);
      expect(await transactionCount(b.member.spaceId)).toBe(1);
    });

    it('compares keys byte for byte', async () => {
      const s = await setup();

      await createWithKey(s.member, 'case-key', expense(s)).expect(201);
      await createWithKey(s.member, 'CASE-KEY', expense(s)).expect(201);

      expect(await transactionCount(s.member.spaceId)).toBe(2);
    });

    it('does not remember a failed request', async () => {
      const s = await setup();

      await createWithKey(s.member, 'retry-after-error', { ...expense(s), category_id: 2147483647 }).expect(403);
      await createWithKey(s.member, 'retry-after-error', expense(s)).expect(201);

      expect(await transactionCount(s.member.spaceId)).toBe(1);
    });

    it('checks access again before answering a repeat', async () => {
      const owner = await setup();
      const guest = await createVerifiedMember(testApp, 'tx-writes-guest');
      userIds.push(guest.userId);
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        owner.member.spaceId,
        guest.userId,
      ]);
      await createWithKey(guest, 'guest-key', expense(owner), owner.member.spaceId).expect(201);
      await testApp.dataSource.query('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [
        owner.member.spaceId,
        guest.userId,
      ]);

      const res = await createWithKey(guest, 'guest-key', expense(owner), owner.member.spaceId).expect(403);

      expect(res.body.code).toBe('FORBIDDEN_SPACE');
    });

    it('runs a repeat as a new request once the key expired', async () => {
      const s = await setup();
      await createWithKey(s.member, 'expiring', expense(s)).expect(201);
      await testApp.dataSource.query(
        "UPDATE idempotency_keys SET expires_at = ? WHERE idempotency_key = 'expiring' AND user_id = ?",
        [new Date(Date.now() - 1000), s.member.userId],
      );

      await createWithKey(s.member, 'expiring', expense(s)).expect(201);

      expect(await transactionCount(s.member.spaceId)).toBe(2);
    });

    it('answers a repeated delete with its original result instead of 404', async () => {
      const s = await setup();
      const created = await createWithKey(s.member, 'to-delete', expense(s)).expect(201);
      const url = `${transactions(s.member)}/${created.body.transaction.id}`;

      await api(s.member).delete(url).set('Idempotency-Key', 'delete-1').set('If-Match', '"1"').expect(200);
      const repeat = await api(s.member)
        .delete(url)
        .set('Idempotency-Key', 'delete-1')
        .set('If-Match', '"1"')
        .expect(200);
      const withoutKey = await api(s.member).delete(url).set('If-Match', '"1"').expect(404);

      expect(repeat.text).toBe('true');
      expect(withoutKey.body.code).toBe('TRANSACTION_NOT_FOUND');
    });

    it('rejects a malformed key before anything is written', async () => {
      const s = await setup();

      const res = await createWithKey(s.member, 'has space', expense(s)).expect(400);

      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          message: [{ field: 'Idempotency-Key', error: 'Idempotency-Key must be 1-255 printable ASCII characters' }],
        }),
      );
      expect(await transactionCount(s.member.spaceId)).toBe(0);
    });

    it('purges expired keys in the background without waiting on a key a request holds', async () => {
      const s = await setup();
      await createWithKey(s.member, 'purge-free', expense(s)).expect(201);
      await createWithKey(s.member, 'purge-held', expense(s)).expect(201);
      await testApp.dataSource.query('UPDATE idempotency_keys SET expires_at = ? WHERE user_id = ?', [
        new Date(Date.now() - 1000),
        s.member.userId,
      ]);
      const holder = testApp.dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction('READ COMMITTED');

      try {
        await holder.query(
          "SELECT id FROM idempotency_keys WHERE user_id = ? AND idempotency_key = 'purge-held' FOR UPDATE",
          [s.member.userId],
        );
        const started = Date.now();

        await testApp.app.get(IdempotencyKeyPurger).purge();

        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
      const keys: { idempotency_key: string }[] = await testApp.dataSource.query(
        'SELECT idempotency_key FROM idempotency_keys WHERE user_id = ?',
        [s.member.userId],
      );
      expect(keys.map((key) => key.idempotency_key)).toEqual(['purge-held']);
    });

    it('applies concurrent repeats once: the second waits for the first and gets its result', async () => {
      const s = await setup();
      const checkpoint = pauseAfterFirstCall(queries(), 'getOneInSpace', insideWrite);

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        CLAIM_KEY,
        () => createWithKey(s.member, 'concurrent', expense(s)),
        () => createWithKey(s.member, 'concurrent', expense(s)),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(await transactionCount(s.member.spaceId)).toBe(1);
    });
  });

  describe('locking', () => {
    it('makes deleting a category wait for a create on it, so the category is archived, not removed', async () => {
      const s = await setup();
      const category = await api(s.member)
        .post(`${base(s.member)}/categories`)
        .send({ name: 'Racing', transaction_type: 'expense', icon: 'Other', color: 'slate' })
        .expect(201);
      const checkpoint = pauseAfterFirstCall(queries(), 'getOneInSpace', insideWrite);

      const [created, deleted] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_SPACE,
        () =>
          api(s.member)
            .post(`${transactions(s.member)}`)
            .send({ ...expense(s), category_id: category.body.id }),
        () => api(s.member).delete(`${base(s.member)}/categories/${category.body.id}`),
      );

      expect(created.status).toBe(201);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ archived: true });
    });

    it('lets one of two concurrent deletes of the same version win', async () => {
      const s = await setup();
      const created = await api(s.member)
        .post(`${transactions(s.member)}`)
        .send(expense(s))
        .expect(201);
      const url = `${transactions(s.member)}/${created.body.transaction.id}`;
      const checkpoint = pauseAfterFirstCall(queries(), 'getOneInSpace', insideWrite);

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_TRANSACTION,
        () => api(s.member).delete(url).set('If-Match', '"1"'),
        () => api(s.member).delete(url).set('If-Match', '"1"'),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
    });

    it('applies one of two concurrent edits from the same version and refuses the other', async () => {
      const s = await setup();
      const created = await api(s.member)
        .post(`${transactions(s.member)}`)
        .send(expense(s))
        .expect(201);
      const url = `${transactions(s.member)}/${created.body.transaction.id}`;
      const checkpoint = pauseAfterFirstCall(queries(), 'getOneInSpace', insideWrite);

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_TRANSACTION,
        () => api(s.member).patch(url).set('If-Match', '"1"').send({ amount: '20' }),
        () => api(s.member).patch(url).set('If-Match', '"1"').send({ amount: '30' }),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      const read = await api(s.member).get(url).expect(200);
      expect(read.body).toEqual(expect.objectContaining({ amount: '20.00', version: 2 }));
    });

    it('refuses a delete of the version an in-flight edit replaces', async () => {
      const s = await setup();
      const created = await api(s.member)
        .post(`${transactions(s.member)}`)
        .send(expense(s))
        .expect(201);
      const url = `${transactions(s.member)}/${created.body.transaction.id}`;
      const checkpoint = pauseAfterFirstCall(queries(), 'getOneInSpace', insideWrite);

      const [edited, deleted] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_TRANSACTION,
        () => api(s.member).patch(url).set('If-Match', '"1"').send({ amount: '20' }),
        () => api(s.member).delete(url).set('If-Match', '"1"'),
      );

      expect(edited.status).toBe(200);
      expect(deleted.status).toBe(409);
      expect(deleted.body.code).toBe('TRANSACTION_VERSION_CONFLICT');
      const read = await api(s.member).get(url).expect(200);
      expect(read.body).toEqual(expect.objectContaining({ amount: '20.00', version: 2 }));
    });
  });

  describe('access revocation', () => {
    async function withGuest(): Promise<Setup & { guest: Member }> {
      const owner = await setup();
      const guest = await createVerifiedMember(testApp, 'tx-writes-guest');
      userIds.push(guest.userId);
      await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
        owner.member.spaceId,
        guest.userId,
      ]);

      return { ...owner, guest };
    }

    const removeGuest = (s: Setup & { guest: Member }) =>
      api(s.member).delete(`${base(s.member)}/members/${s.guest.userId}`);

    it("makes a member removal wait for the member's in-flight create, then refuses the next one", async () => {
      const s = await withGuest();
      const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');

      const [created, removed] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_MEMBERS,
        () => createWithKey(s.guest, 'in-flight', expense(s), s.member.spaceId),
        () => removeGuest(s),
      );

      expect(created.status).toBe(201);
      expect(removed.status).toBe(200);
      const after = await createWithKey(s.guest, 'after-removal', expense(s), s.member.spaceId).expect(403);
      expect(after.body.code).toBe('FORBIDDEN_SPACE');
      expect(await transactionCount(s.member.spaceId)).toBe(1);
    });

    it("makes a member removal wait for the member's in-flight delete", async () => {
      const s = await withGuest();
      const created = await createWithKey(s.guest, 'to-delete', expense(s), s.member.spaceId).expect(201);
      const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');

      const [deleted, removed] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_MEMBERS,
        () =>
          api(s.guest)
            .delete(`${transactions(s.guest, s.member.spaceId)}/${created.body.transaction.id}`)
            .set('If-Match', '"1"'),
        () => removeGuest(s),
      );

      expect([deleted.status, removed.status]).toEqual([200, 200]);
      expect(await transactionCount(s.member.spaceId)).toBe(0);
    });
  });
});
