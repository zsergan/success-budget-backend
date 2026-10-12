import request from 'supertest';

import { type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

// Also run with TZ=America/Chicago: client instants and server-generated
// timestamps must not depend on the Node host's local timezone.
describe('Database timestamps (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  it.each([
    '2026-09-15T10:00:00.250Z',
    '2025-11-02T06:30:00.000Z',
    '2025-11-02T07:30:00.000Z',
    '1970-01-01T00:00:01.000Z',
  ])('stores %s as the exact instant, including DST overlap and the minimum timestamp', async (timestamp) => {
    const member = await createVerifiedMember(testApp, 'database-timestamps');
    userIds.push(member.userId);
    const base = `/api/v1/spaces/${member.spaceId}`;
    const auth = { Authorization: `Bearer ${member.token}` };
    const server = testApp.app.getHttpServer();
    const wallet = await request(server)
      .post(`${base}/wallets`)
      .set(auth)
      .send({ wallet_name: 'Card', initial_balance: '0', design: 'slate' })
      .expect(201);
    const categories = await request(server).get(`${base}/categories`).set(auth).expect(200);
    const created = await request(server)
      .post(`${base}/transactions`)
      .set(auth)
      .send({
        wallet_id: wallet.body.wallet.id,
        category_id: categories.body.expenses[0].id,
        transaction_type: 'expense',
        amount: '10',
        timestamp,
      })
      .expect(201);

    expect(created.body.transaction.timestamp).toBe(timestamp);
    const [stored] = await testApp.dataSource.query(
      'SELECT UNIX_TIMESTAMP(timestamp) AS epoch FROM transactions WHERE id = ?',
      [created.body.transaction.id],
    );
    expect(Number(stored.epoch) * 1000).toBe(Date.parse(timestamp));
    const [clock] = await testApp.dataSource.query(
      'SELECT CURRENT_TIMESTAMP(3) AS now, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) AS epoch',
    );
    expect(clock.now.getTime()).toBe(Number(clock.epoch) * 1000);
  });
});
