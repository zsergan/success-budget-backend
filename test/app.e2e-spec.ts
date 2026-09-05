import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { ConfirmationCode } from '@entities/confirmation-codes.entity';

describe('App (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const testEmail = `e2e-${Date.now()}@example.com`;
  const testPassword = 'DevTest#2026';
  let userId: number;
  let token: string;
  let walletId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    // try/finally is load-bearing: if the cleanup query throws and
    // app.close() never runs, the TypeORM connection pool stays open and
    // Jest hangs instead of exiting.
    try {
      if (userId) {
        // limits.category_id (now limit_categories.category_id) and
        // transactions.category_id are both RESTRICT (categories/currencies
        // keep their history even if the owning user's data is torn down),
        // so a plain `DELETE FROM users` fails with an FK error once this
        // file creates a limit or a transaction scoped to a category -
        // delete those first. onDelete: CASCADE then takes the wallet,
        // categories, and confirmation code with the user.
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.user_id = ?',
          [userId],
        );
        await dataSource.query('DELETE FROM limits WHERE user_id = ?', [userId]);
        await dataSource.query(
          'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ?',
          [userId],
        );
        await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
      }
    } finally {
      await app.close();
    }
  });

  it('GET /api/v1/currencies is public and returns the seeded list', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/currencies').expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/health is public and reports the database as up', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

    expect(response.body.status).toBe('ok');
  });

  it('GET /api/v1/wallets without a token is rejected', async () => {
    await request(app.getHttpServer()).get('/api/v1/wallets').expect(401);
  });

  it('rejects registration payloads with unrecognized fields (mass assignment)', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');

    await request(app.getHttpServer())
      .post('/api/v1/users/register')
      .send({
        name: 'E2E Test',
        email: testEmail,
        password: testPassword,
        base_currency_id: currencies.body[0].id,
        email_verified: 1,
      })
      .expect(400);
  });

  it('runs the full register -> verify -> login -> use-a-protected-route flow', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    const baseCurrencyId = currencies.body[0].id;

    const registerResponse = await request(app.getHttpServer())
      .post('/api/v1/users/register')
      .send({ name: 'E2E Test', email: testEmail, password: testPassword, base_currency_id: baseCurrencyId })
      .expect(201);

    userId = registerResponse.body.id;
    expect(registerResponse.body.password).toBeUndefined();

    await request(app.getHttpServer())
      .post('/api/v1/users/login')
      .send({ email: testEmail, password: testPassword })
      .expect(403);

    const confirmationCodeRepository = dataSource.getRepository(ConfirmationCode);
    const confirmationCode = await confirmationCodeRepository.findOneOrFail({ where: { user_id: userId } });

    await request(app.getHttpServer())
      .post('/api/v1/users/verify-email')
      .send({ email: testEmail, code: confirmationCode.confirmation_code })
      .expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/users/login')
      .send({ email: testEmail, password: testPassword })
      .expect(201);

    token = loginResponse.text;
    expect(typeof token).toBe('string');

    const profileResponse = await request(app.getHttpServer())
      .get('/api/v1/users/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(profileResponse.body.email).toBe(testEmail);

    const walletsResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(walletsResponse.body).toHaveLength(1);
    expect(walletsResponse.body[0].wallet.wallet_name).toBe('Cash');
    walletId = walletsResponse.body[0].wallet.id;
  });

  it('creates transactions, filters by date range, reports the latest one, and undoes one', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const salaryCategoryId = categoriesResponse.body.incomes.find((category) => category.name === 'Salary').id;
    const groceriesCategoryId = categoriesResponse.body.expenses.find((category) => category.name === 'Grocery').id;

    const incomeResponse = await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: salaryCategoryId,
        transaction_type: 'income',
        amount: '500.00',
        timestamp: new Date().toISOString(),
        description: 'e2e salary',
      })
      .expect(201);

    expect(incomeResponse.body.transaction.wallet_id).toBeUndefined();
    expect(incomeResponse.body.transaction.category_id).toBeUndefined();
    expect(Number(incomeResponse.body.previous_balance)).toBe(0);
    expect(Number(incomeResponse.body.wallet.balance)).toBe(500);

    // description is optional - the design's Note field has no required marker.
    const expenseResponse = await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: groceriesCategoryId,
        transaction_type: 'expense',
        amount: '120.50',
        timestamp: new Date().toISOString(),
      })
      .expect(201);

    expect(Number(expenseResponse.body.previous_balance)).toBe(500);
    expect(Number(expenseResponse.body.wallet.balance)).toBe(379.5);
    const expenseTransactionId = expenseResponse.body.transaction.id;

    const withinRange = await request(app.getHttpServer())
      .get('/api/v1/transactions')
      .query({
        from: new Date(Date.now() - 86400000).toISOString(),
        to: new Date(Date.now() + 86400000).toISOString(),
      })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(withinRange.body.length).toBeGreaterThanOrEqual(2);
    for (const transaction of withinRange.body) {
      expect(transaction.wallet_id).toBeUndefined();
      expect(transaction.category_id).toBeUndefined();
      expect(transaction.currency_id).toBeUndefined();
    }

    const outsideRange = await request(app.getHttpServer())
      .get('/api/v1/transactions')
      .query({ from: '2000-01-01T00:00:00.000Z', to: '2000-01-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(outsideRange.body).toHaveLength(0);

    const latestResponse = await request(app.getHttpServer())
      .get('/api/v1/transactions/latest')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(latestResponse.body.id).toBe(expenseTransactionId);

    await request(app.getHttpServer())
      .delete(`/api/v1/transactions/${expenseTransactionId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const walletsResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const wallet = walletsResponse.body.find((entry) => entry.wallet.id === walletId);
    expect(Number(wallet.wallet.balance)).toBe(500);
  });

  it('supports a monthly total limit, a group limit, and a single-category limit together', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const healthCategoryId = categoriesResponse.body.expenses.find((category) => category.name === 'Health').id;
    const restaurantsCategoryId = categoriesResponse.body.expenses.find(
      (category) => category.name === 'Restaurant',
    ).id;
    const entertainmentCategoryId = categoriesResponse.body.expenses.find(
      (category) => category.name === 'Entertainment',
    ).id;

    await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: healthCategoryId,
        transaction_type: 'expense',
        amount: '40.00',
        timestamp: new Date().toISOString(),
      })
      .expect(201);

    const totalLimitResponse = await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '1000.00' })
      .expect(201);
    const totalLimitId = totalLimitResponse.body.id;

    const healthLimitResponse = await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [healthCategoryId], amount: '100.00' })
      .expect(201);
    const healthLimitId = healthLimitResponse.body.id;

    await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [restaurantsCategoryId, entertainmentCategoryId], amount: '50.00' })
      .expect(400);

    const funLimitResponse = await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [restaurantsCategoryId, entertainmentCategoryId], name: 'Fun', amount: '50.00' })
      .expect(201);
    const funLimitId = funLimitResponse.body.id;

    // Health is already claimed by healthLimitId - reusing it must be rejected
    await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [healthCategoryId], amount: '30.00' })
      .expect(400);

    // a second monthly total limit must also be rejected
    await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '500.00' })
      .expect(400);

    const limitsResponse = await request(app.getHttpServer())
      .get('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(limitsResponse.body.total).toMatchObject({ id: totalLimitId, spent: 40, in_percent: 4 });

    const healthLimit = limitsResponse.body.categories.find((limit) => limit.id === healthLimitId);
    expect(healthLimit).toMatchObject({ spent: 40, in_percent: 40 });
    expect(healthLimit.categories.map((category) => category.id)).toEqual([healthCategoryId]);

    const funLimit = limitsResponse.body.categories.find((limit) => limit.id === funLimitId);
    expect(funLimit).toMatchObject({ name: 'Fun', spent: 0, in_percent: 0 });
    expect(funLimit.categories.map((category) => category.id).sort()).toEqual(
      [restaurantsCategoryId, entertainmentCategoryId].sort(),
    );

    for (const limit of [...limitsResponse.body.categories, limitsResponse.body.total]) {
      expect(limit.user_id).toBeUndefined();
    }

    await request(app.getHttpServer())
      .delete(`/api/v1/limits/${healthLimitId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // already deleted - re-deleting is treated the same as "not yours"
    await request(app.getHttpServer())
      .delete(`/api/v1/limits/${healthLimitId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    const afterDeleteResponse = await request(app.getHttpServer())
      .get('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterDeleteResponse.body.categories.find((limit) => limit.id === healthLimitId)).toBeUndefined();
  });

  it('deletes an unused category, archives one with history, and never accepts transaction_type on update', async () => {
    const createUnused = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Unused', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const unusedCategoryId = createUnused.body.id;

    await request(app.getHttpServer())
      .delete(`/api/v1/categories/${unusedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: false }));

    const afterHardDelete = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterHardDelete.body.expenses.find((category) => category.id === unusedCategoryId)).toBeUndefined();
    expect(afterHardDelete.body.archived.find((category) => category.id === unusedCategoryId)).toBeUndefined();

    const createUsed = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Used', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const usedCategoryId = createUsed.body.id;

    await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: usedCategoryId,
        transaction_type: 'expense',
        amount: '10.00',
        timestamp: new Date().toISOString(),
      })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ transaction_type: 'income' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/api/v1/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: true }));

    const afterArchive = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterArchive.body.expenses.find((category) => category.id === usedCategoryId)).toBeUndefined();
    const archivedView = afterArchive.body.archived.find((category) => category.id === usedCategoryId);
    expect(archivedView).toMatchObject({ transaction_count: 1, is_active: 0 });
    expect(archivedView.archived_at).toEqual(expect.any(String));
    expect(archivedView.user_id).toBeUndefined();
    expect(archivedView.sort).toBeUndefined();

    await request(app.getHttpServer())
      .put(`/api/v1/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: 1 })
      .expect(200);

    const afterRestore = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const restoredView = afterRestore.body.expenses.find((category) => category.id === usedCategoryId);
    expect(restoredView).toMatchObject({ is_active: 1 });
    expect(restoredView.archived_at).toBeNull();
    expect(afterRestore.body.archived.find((category) => category.id === usedCategoryId)).toBeUndefined();
  });

  it('archiving a category unlinks it from its limit, and deletes an emptied single-category limit', async () => {
    const createLimited = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Limited', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const limitedCategoryId = createLimited.body.id;

    await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: limitedCategoryId,
        transaction_type: 'expense',
        amount: '5.00',
        timestamp: new Date().toISOString(),
      })
      .expect(201);

    const createLimit = await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [limitedCategoryId], amount: '20.00' })
      .expect(201);
    const limitId = createLimit.body.id;

    const beforeDelete = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(beforeDelete.body.expenses.find((category) => category.id === limitedCategoryId).limit).toMatchObject({
      id: limitId,
    });

    await request(app.getHttpServer())
      .delete(`/api/v1/categories/${limitedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: true }));

    const afterArchive = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const archivedView = afterArchive.body.archived.find((category) => category.id === limitedCategoryId);
    expect(archivedView.limit).toBeNull();

    const limitsAfterArchive = await request(app.getHttpServer())
      .get('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(limitsAfterArchive.body.categories.find((limit) => limit.id === limitId)).toBeUndefined();

    // restoring must not resurrect the (now-deleted) limit link
    await request(app.getHttpServer())
      .put(`/api/v1/categories/${limitedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: 1 })
      .expect(200);

    const afterRestore = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterRestore.body.expenses.find((category) => category.id === limitedCategoryId).limit).toBeNull();
  });

  it('reorders a segment and persists the new order', async () => {
    const createFirst = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Reorder A', transaction_type: 'income', icon: 'Other', color: 'slate' })
      .expect(201);
    const createSecond = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Reorder B', transaction_type: 'income', icon: 'Other', color: 'slate' })
      .expect(201);
    const firstId = createFirst.body.id;
    const secondId = createSecond.body.id;

    await request(app.getHttpServer())
      .put('/api/v1/categories/reorder')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [secondId, firstId] })
      .expect(200);

    const afterReorder = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const ids = afterReorder.body.incomes.map((category) => category.id);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));

    // an id that isn't the caller's own must reject the whole batch
    await request(app.getHttpServer())
      .put('/api/v1/categories/reorder')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [firstId, 999999999] })
      .expect(403);
  });
});
