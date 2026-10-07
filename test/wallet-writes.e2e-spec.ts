import request from 'supertest';

import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { overlap, pauseAfterFirstCall } from './support/concurrency';

const REMOVE_MEMBER = 'DELETE FROM `space_members`%';
const LOCK_WALLET = '%FROM `wallets` `row`%FOR UPDATE%';

describe('Wallet writes (e2e)', () => {
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
    owner: Member;
    guest: Member;
    walletId: number;
  }

  async function setup(): Promise<Setup> {
    const owner = await createVerifiedMember(testApp, 'wallet-writes');
    const guest = await createVerifiedMember(testApp, 'wallet-writes-guest');
    userIds.push(owner.userId, guest.userId);
    await testApp.dataSource.query("INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')", [
      owner.spaceId,
      guest.userId,
    ]);
    const wallet = await api(owner)
      .post(wallets({ owner }))
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);

    return { owner, guest, walletId: wallet.body.wallet.id };
  }

  // the guest acts in the owner's space
  function wallets({ owner }: Pick<Setup, 'owner'>): string {
    return `/api/v1/spaces/${owner.spaceId}/wallets`;
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'put' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), put: withAuth('put'), delete: withAuth('delete') };
  }

  function removeGuest({ owner, guest }: Setup): request.Test {
    return api(owner).delete(`/api/v1/spaces/${owner.spaceId}/members/${guest.userId}`);
  }

  async function walletRows(spaceId: number): Promise<{ wallet_name: string; is_deleted: number }[]> {
    return testApp.dataSource.query('SELECT wallet_name, is_deleted FROM wallets WHERE space_id = ? ORDER BY id', [
      spaceId,
    ]);
  }

  const writes: Array<[string, (s: Setup) => request.Test, number]> = [
    [
      'create with an initial balance',
      (s) => api(s.guest).post(wallets(s)).send({ wallet_name: 'Savings', initial_balance: '50', design: 'slate' }),
      201,
    ],
    [
      'rename',
      (s) =>
        api(s.guest)
          .put(`${wallets(s)}/${s.walletId}`)
          .send({ wallet_name: 'Renamed' }),
      200,
    ],
    ['delete', (s) => api(s.guest).delete(`${wallets(s)}/${s.walletId}`), 200],
  ];

  describe.each(writes)('%s', (_, write, status) => {
    it('makes a member removal wait until the write commits', async () => {
      const s = await setup();
      const checkpoint = pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace');

      const [written, removed] = await overlap(
        testApp.dataSource,
        checkpoint,
        REMOVE_MEMBER,
        () => write(s),
        () => removeGuest(s),
      );

      expect(written.status).toBe(status);
      expect(removed.status).toBe(200);
    });

    it('refuses the write once the removal has committed and writes nothing', async () => {
      const s = await setup();
      await removeGuest(s).expect(200);
      const before = await walletRows(s.owner.spaceId);

      const res = await write(s).expect(403);

      expect(res.body.code).toBe('FORBIDDEN_SPACE');
      expect(await walletRows(s.owner.spaceId)).toEqual(before);
    });
  });

  it('makes a wallet delete wait for a transaction write on the wallet', async () => {
    const s = await setup();
    const categories = await api(s.owner).get(`/api/v1/spaces/${s.owner.spaceId}/categories`).expect(200);
    const insideWrite = (_self: unknown, args: unknown[]) => args.length > 1 && args[args.length - 1] !== undefined;
    const checkpoint = pauseAfterFirstCall(testApp.app.get(TransactionQueriesService), 'getBalances', insideWrite);

    const [created, deleted] = await overlap(
      testApp.dataSource,
      checkpoint,
      LOCK_WALLET,
      () =>
        api(s.owner).post(`/api/v1/spaces/${s.owner.spaceId}/transactions`).send({
          wallet_id: s.walletId,
          category_id: categories.body.expenses[0].id,
          transaction_type: 'expense',
          amount: '5.00',
          timestamp: '2026-09-15T10:00:00.000Z',
        }),
      () => api(s.owner).delete(`${wallets(s)}/${s.walletId}`),
    );

    expect(created.status).toBe(201);
    expect(deleted.status).toBe(200);
    expect(await walletRows(s.owner.spaceId)).toContainEqual({ wallet_name: 'Card', is_deleted: 1 });
  });
});
