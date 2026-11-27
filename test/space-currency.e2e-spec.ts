import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

// PATCH /spaces/:id/currency relabels a space: the owner picks another
// currency and every amount keeps its number; nothing is converted.
describe('Space currency change (e2e)', () => {
  let testApp: TestApp;
  let owner: Member;
  let stranger: Member;

  const as = (member: Member) => {
    const agent = request(testApp.app.getHttpServer());
    const auth = (test: request.Test) => test.set('Authorization', `Bearer ${member.token}`);

    return {
      get: (url: string) => auth(agent.get(url)),
      post: (url: string) => auth(agent.post(url)),
      patch: (url: string) => auth(agent.patch(url)),
    };
  };
  const currencyIdOf = async (code: string): Promise<number> => {
    const [row] = await testApp.dataSource.query('SELECT id FROM currencies WHERE code = ?', [code]);

    return row.id;
  };

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await createVerifiedMember(testApp, 'space-currency-owner');
    stranger = await createVerifiedMember(testApp, 'space-currency-stranger');
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [owner?.userId, stranger?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  it('lets the owner relabel the space, keeping every amount as it was', async () => {
    const categories = await as(owner).get(`/api/v1/spaces/${owner.spaceId}/categories`).expect(200);
    const created = await as(owner)
      .post(`/api/v2/spaces/${owner.spaceId}/transactions`)
      .send({
        category_id: categories.body.expenses[0].id,
        transaction_type: 'expense',
        amount: '42.50',
        date: '2026-09-10',
        time_zone: 'UTC',
        assignment: { kind: 'space' },
      })
      .expect(201);
    const eur = await currencyIdOf('EUR');

    const updated = await as(owner)
      .patch(`/api/v1/spaces/${owner.spaceId}/currency`)
      .send({ currency_id: eur })
      .expect(200);

    expect(updated.body.currency).toMatchObject({ id: eur, code: 'EUR' });
    const spaces = await as(owner).get('/api/v1/spaces').expect(200);
    expect(spaces.body.find((space: { id: number }) => space.id === owner.spaceId).currency.code).toBe('EUR');
    const read = await as(owner)
      .get(`/api/v2/spaces/${owner.spaceId}/transactions/${created.body.transaction.id}`)
      .expect(200);
    expect(read.body.amount).toBe('42.50');
  });

  it('refuses anyone who is not the owner', async () => {
    const response = await as(stranger)
      .patch(`/api/v1/spaces/${owner.spaceId}/currency`)
      .send({ currency_id: await currencyIdOf('USD') })
      .expect(403);

    expect(response.body.code).toBe('FORBIDDEN_SPACE');
  });

  it('refuses a currency that does not exist and a malformed body', async () => {
    const unknown = await as(owner)
      .patch(`/api/v1/spaces/${owner.spaceId}/currency`)
      .send({ currency_id: 999999 })
      .expect(400);
    expect(unknown.body.code).toBe('CURRENCY_NOT_FOUND');

    const malformed = await as(owner)
      .patch(`/api/v1/spaces/${owner.spaceId}/currency`)
      .send({ currency_id: 'EUR' })
      .expect(400);
    expect(malformed.body.code).toBe('VALIDATION_FAILED');
  });
});
