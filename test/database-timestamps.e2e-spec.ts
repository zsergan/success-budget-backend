import request from 'supertest';

import { type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

// Also run with TZ=America/Chicago: calendar dates and server-generated
// timestamps must not depend on the Node host's local timezone.
describe('Database dates and timestamps (e2e)', () => {
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

  it.each(['2026-09-15', '2025-11-02', '2026-03-08', '2000-02-29', '1969-12-31', '1000-01-01'])(
    'stores %s as that calendar date and reads it back unchanged, in any zone',
    async (date) => {
      const member = await createVerifiedMember(testApp, 'database-dates');
      userIds.push(member.userId);
      const auth = { Authorization: `Bearer ${member.token}` };
      const server = testApp.app.getHttpServer();
      const categories = await request(server).get(`/api/v1/spaces/${member.spaceId}/categories`).set(auth).expect(200);
      const created = await request(server)
        .post(`/api/v2/spaces/${member.spaceId}/transactions`)
        .set(auth)
        .send({
          category_id: categories.body.expenses[0].id,
          transaction_type: 'expense',
          amount: '10',
          date,
          time_zone: 'Pacific/Kiritimati',
          assignment: { kind: 'space' },
        })
        .expect(201);

      expect(created.body.transaction.date).toBe(date);
      const [stored] = await testApp.dataSource.query(
        "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS formatted, date FROM transactions WHERE id = ?",
        [created.body.transaction.id],
      );
      expect(stored).toEqual({ formatted: date, date });
      const feed = await request(server)
        .get(`/api/v2/spaces/${member.spaceId}/transactions/feed`)
        .set(auth)
        .query({ from_date: date, to_date: date })
        .expect(200);
      expect(feed.body.items.map((item: { date: string }) => item.date)).toEqual([date]);
      expect(feed.body.day_totals).toEqual([{ date, net: '-10.00' }]);
    },
  );

  it('reads server-generated timestamps as UTC', async () => {
    const [clock] = await testApp.dataSource.query(
      'SELECT CURRENT_TIMESTAMP(3) AS now, UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) AS epoch',
    );

    expect(clock.now.getTime()).toBe(Number(clock.epoch) * 1000);
  });
});
