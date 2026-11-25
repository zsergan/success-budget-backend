import request from 'supertest';

import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

// A category color is a preset or a custom #RRGGBB (docs/type-contract.md#category-colors),
// and every category-bearing response returns it as stored.
describe('Category colors (e2e)', () => {
  let testApp: TestApp;
  let member: Member;

  const api = () => {
    const agent = request(testApp.app.getHttpServer());
    const auth = (test: request.Test) => test.set('Authorization', `Bearer ${member.token}`);

    return {
      get: (url: string) => auth(agent.get(url)),
      post: (url: string) => auth(agent.post(url)),
      put: (url: string) => auth(agent.put(url)),
    };
  };
  const v1 = (path = '') => `/api/v1/spaces/${member.spaceId}${path}`;
  const v2 = (path = '') => `/api/v2/spaces/${member.spaceId}${path}`;
  const COLOR_ERROR = 'color must be one of slate, amber, evergreen, indigo, clay, plum or a #RRGGBB color';

  beforeAll(async () => {
    testApp = await createTestApp();
    member = await createVerifiedMember(testApp, 'category-colors');
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, [member?.userId].filter(Boolean));
    } finally {
      await testApp.app.close();
    }
  });

  const createCategory = (name: string, color: unknown) =>
    api().post(v1('/categories')).send({ name, transaction_type: 'expense', icon: 'Cafe', color });

  it('stores a custom color upper-case and returns it in every category-bearing read', async () => {
    const created = await createCategory('Custom', '#3a7bd5').expect(201);
    const categoryId = created.body.id;
    expect(created.body.color).toBe('#3A7BD5');
    const [stored] = await testApp.dataSource.query('SELECT color FROM categories WHERE id = ?', [categoryId]);
    expect(stored.color).toBe('#3A7BD5');

    const transaction = await api()
      .post(v2('/transactions'))
      .send({
        category_id: categoryId,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        time_zone: 'UTC',
        assignment: { kind: 'space' },
      })
      .expect(201);
    await api()
      .post(v1('/limits'))
      .send({ amount: '100', category_ids: [categoryId] })
      .expect(201);

    const categories = await api().get(v1('/categories')).expect(200);
    const read = await api()
      .get(v2(`/transactions/${transaction.body.transaction.id}`))
      .expect(200);
    const feed = await api()
      .get(v2('/transactions/feed'))
      .query({ from_date: '2026-09-01', to_date: '2026-09-30' })
      .expect(200);
    const breakdown = await api()
      .get(v2('/statistics/breakdown'))
      .query({ period: 'month', anchor_date: '2026-09-15', time_zone: 'UTC' })
      .expect(200);
    const limits = await api().get(v1('/limits')).query({ time_zone: 'UTC' }).expect(200);

    expect(categories.body.expenses.find((category: { id: number }) => category.id === categoryId).color).toBe(
      '#3A7BD5',
    );
    expect(transaction.body.transaction.category.color).toBe('#3A7BD5');
    expect(read.body.category.color).toBe('#3A7BD5');
    expect(feed.body.items[0].category.color).toBe('#3A7BD5');
    expect(breakdown.body.by_category.primary_items).toEqual([
      expect.objectContaining({ id: categoryId, color: '#3A7BD5' }),
    ]);
    expect(limits.body.categories[0].categories).toEqual([
      expect.objectContaining({ id: categoryId, color: '#3A7BD5' }),
    ]);

    const document = createOpenApiDocument(testApp.app);
    expect(
      schemaErrors(document, okResponseSchema(document, 'v2/spaces/{spaceId}/transactions/feed'), feed.body),
    ).toEqual([]);
    expect(schemaErrors(document, okResponseSchema(document, '/statistics/breakdown'), breakdown.body)).toEqual([]);
  });

  it('keeps preset tokens as they are, and moves between presets and custom colors on edit', async () => {
    const created = await createCategory('Preset', 'plum').expect(201);
    const id = created.body.id;
    const colorOf = async () =>
      (await api().get(v1('/categories')).expect(200)).body.expenses.find(
        (category: { id: number }) => category.id === id,
      ).color;

    expect(created.body.color).toBe('plum');
    await api()
      .put(v1(`/categories/${id}`))
      .send({ color: '#00aa11' })
      .expect(200);
    expect(await colorOf()).toBe('#00AA11');
    await api()
      .put(v1(`/categories/${id}`))
      .send({ color: 'evergreen' })
      .expect(200);
    expect(await colorOf()).toBe('evergreen');
  });

  it.each(['#FFF', '#3A7BD5FF', '3A7BD5', 'red', 'Slate', 'rgb(58, 123, 213)', ' #3A7BD5', ''])(
    'refuses %p on create and edit, writing nothing',
    async (color) => {
      const before = await testApp.dataSource.query('SELECT COUNT(*) AS count FROM categories WHERE space_id = ?', [
        member.spaceId,
      ]);
      const created = await createCategory('Refused', color).expect(400);
      const [{ id }] = (await api().get(v1('/categories')).expect(200)).body.expenses;
      const edited = await api()
        .put(v1(`/categories/${id}`))
        .send({ color })
        .expect(400);
      const after = await testApp.dataSource.query('SELECT COUNT(*) AS count FROM categories WHERE space_id = ?', [
        member.spaceId,
      ]);

      expect(created.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: [{ field: 'color', error: COLOR_ERROR }],
      });
      expect(edited.body.message).toEqual([{ field: 'color', error: COLOR_ERROR }]);
      expect(Number(after[0].count)).toBe(Number(before[0].count));
    },
  );
});
