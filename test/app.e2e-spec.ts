import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { Category } from '@entities/category.entity';

describe('App (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const testEmail = `e2e-${Date.now()}@example.com`;
  const secondTestEmail = `e2e-second-${Date.now()}@example.com`;
  const testPassword = 'DevTest#2026';
  let userId: number;
  let token: string;
  let walletId: number;
  let secondUserId: number;
  let secondUserToken: string;
  let groupSpaceId: number;
  let personalSpaceId: number;
  const createdSpaceIds: number[] = [];

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
      // wallets/categories/limits are space_id-scoped now (Stage 2), all
      // CASCADE from spaces - but limit_categories.category_id is RESTRICT
      // (phase-13 decision), so the join table and limits must be cleared
      // *before* the space delete below, or the cascade into categories
      // hits that RESTRICT mid-transaction. Transactions have no space_id
      // column of their own (ownership is derived via wallet_id ->
      // wallet.space_id) - clear them too, before their wallets go.
      if (createdSpaceIds.length) {
        await dataSource.query(
          'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?)',
          [createdSpaceIds],
        );
        await dataSource.query('DELETE FROM limits WHERE space_id IN (?)', [createdSpaceIds]);
        await dataSource.query(
          'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id IN (?)',
          [createdSpaceIds],
        );
      }

      // Spaces (personal + the group space, whichever user currently owns
      // it after the ownership-transfer scenario) have no FK back to users,
      // so they'd be left as orphan rows if only `DELETE FROM users` ran -
      // clean them up explicitly, before the users that reference them.
      // This also cascades the now-empty wallets/categories.
      if (createdSpaceIds.length) {
        await dataSource.query('DELETE FROM space_invites WHERE space_id IN (?)', [createdSpaceIds]);
        await dataSource.query('DELETE FROM space_members WHERE space_id IN (?)', [createdSpaceIds]);
        await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [createdSpaceIds]);
      }

      if (userId) {
        await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
      }

      if (secondUserId) {
        await dataSource.query('DELETE FROM users WHERE id = ?', [secondUserId]);
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

  it('GET a space wallets list without a token is rejected', async () => {
    // the JWT guard runs before any spaceId is ever read, so the id here is a placeholder
    await request(app.getHttpServer()).get('/api/v1/spaces/1/wallets').expect(401);
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
    expect(profileResponse.body.base_currency).toBeUndefined();

    const spacesResponse = await request(app.getHttpServer())
      .get('/api/v1/spaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(spacesResponse.body).toHaveLength(1);
    expect(spacesResponse.body[0]).toMatchObject({
      name: 'Personal',
      type: 'personal',
      role: 'owner',
      member_count: 1,
    });
    expect(spacesResponse.body[0].currency.id).toBe(baseCurrencyId);
    personalSpaceId = spacesResponse.body[0].id;
    createdSpaceIds.push(personalSpaceId);

    const walletsResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(walletsResponse.body.wallets).toHaveLength(1);
    expect(walletsResponse.body.wallets[0].wallet.wallet_name).toBe('Cash');
    const baseCurrency = currencies.body.find((currency) => currency.id === baseCurrencyId);
    expect(walletsResponse.body.total_balance).toBe(0);
    expect(walletsResponse.body.total_balance_currency).toBe(baseCurrency.code);
    expect(walletsResponse.body.delta_percent).toBe(0);
    walletId = walletsResponse.body.wallets[0].wallet.id;
  });

  it('creates a wallet with a starting balance recorded as a real transaction against the system category', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wallet_name: 'Invalid', initial_balance: '-5', design: 'slate' })
      .expect(400);

    const zeroResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wallet_name: 'Empty', initial_balance: '0', design: 'slate' })
      .expect(201);
    expect(zeroResponse.body.transaction).toBeNull();
    expect(Number(zeroResponse.body.wallet.balance)).toBe(0);

    const savingsResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .send({ wallet_name: 'Savings', initial_balance: '200.00', design: 'amber' })
      .expect(201);

    expect(Number(savingsResponse.body.wallet.balance)).toBe(200);
    expect(savingsResponse.body.transaction).toMatchObject({ transaction_type: 'income', amount: 200 });
    const savingsWalletId = savingsResponse.body.wallet.id;

    const walletsResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(walletsResponse.body.wallets).toHaveLength(3);
    expect(walletsResponse.body.total_balance).toBe(200);

    const transactionsResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/transactions`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const initialBalanceTransaction = transactionsResponse.body.find(
      (transaction) => transaction.wallet.id === savingsWalletId,
    );
    expect(initialBalanceTransaction.category.name).toBe('Initial balance');
  });

  it('rejects operations against the space system category', async () => {
    const categoryRepository = dataSource.getRepository(Category);
    const systemCategory = await categoryRepository.findOneOrFail({
      where: { space_id: personalSpaceId, is_system: 1 },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: systemCategory.id,
        transaction_type: 'income',
        amount: '1.00',
        timestamp: new Date().toISOString(),
      })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/${systemCategory.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hacked' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/categories/${systemCategory.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);

    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [systemCategory.id] })
      .expect(400);

    const categoriesResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const allVisible = [
      ...categoriesResponse.body.incomes,
      ...categoriesResponse.body.expenses,
      ...categoriesResponse.body.archived,
    ];
    expect(allVisible.find((category) => category.id === systemCategory.id)).toBeUndefined();
  });

  it('creates transactions, filters by date range, reports the latest one, and undoes one', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const salaryCategoryId = categoriesResponse.body.incomes.find((category) => category.name === 'Salary').id;
    const groceriesCategoryId = categoriesResponse.body.expenses.find((category) => category.name === 'Grocery').id;

    const incomeResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .get(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .get(`/api/v1/spaces/${personalSpaceId}/transactions`)
      .query({ from: '2000-01-01T00:00:00.000Z', to: '2000-01-31T23:59:59.999Z' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(outsideRange.body).toHaveLength(0);

    const latestResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/transactions/latest`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(latestResponse.body.id).toBe(expenseTransactionId);

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/transactions/${expenseTransactionId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const walletsResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const wallet = walletsResponse.body.wallets.find((entry) => entry.wallet.id === walletId);
    expect(Number(wallet.wallet.balance)).toBe(500);
    // total_balance sums every wallet in the space now that currency is
    // unified at the space level: Cash (500) + Savings (200, from the
    // prior test's starting-balance transaction) = 700. net across the
    // period equals total_balance here too (the deleted expense no longer
    // counts), so balance_at_period_start is 0 and delta_percent falls
    // back to the divide-by-zero guard.
    expect(walletsResponse.body.total_balance).toBe(700);
    expect(walletsResponse.body.delta_percent).toBe(0);
  });

  it('supports a monthly total limit, a group limit, and a single-category limit together', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
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
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '1000.00' })
      .expect(201);
    const totalLimitId = totalLimitResponse.body.id;

    const healthLimitResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [healthCategoryId], amount: '100.00' })
      .expect(201);
    const healthLimitId = healthLimitResponse.body.id;

    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [restaurantsCategoryId, entertainmentCategoryId], amount: '50.00' })
      .expect(400);

    const funLimitResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [restaurantsCategoryId, entertainmentCategoryId], name: 'Fun', amount: '50.00' })
      .expect(201);
    const funLimitId = funLimitResponse.body.id;

    // Health is already claimed by healthLimitId - reusing it must be rejected
    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [healthCategoryId], amount: '30.00' })
      .expect(400);

    // a second monthly total limit must also be rejected
    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '500.00' })
      .expect(400);

    const limitsResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/limits`)
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
      .delete(`/api/v1/spaces/${personalSpaceId}/limits/${healthLimitId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // already deleted - re-deleting is treated the same as "not yours"
    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/limits/${healthLimitId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    const afterDeleteResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterDeleteResponse.body.categories.find((limit) => limit.id === healthLimitId)).toBeUndefined();
  });

  it('deletes an unused category, archives one with history, and never accepts transaction_type on update', async () => {
    const createUnused = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Unused', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const unusedCategoryId = createUnused.body.id;

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/categories/${unusedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: false }));

    const afterHardDelete = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterHardDelete.body.expenses.find((category) => category.id === unusedCategoryId)).toBeUndefined();
    expect(afterHardDelete.body.archived.find((category) => category.id === unusedCategoryId)).toBeUndefined();

    const createUsed = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Used', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const usedCategoryId = createUsed.body.id;

    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .put(`/api/v1/spaces/${personalSpaceId}/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ transaction_type: 'income' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: true }));

    const afterArchive = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(afterArchive.body.expenses.find((category) => category.id === usedCategoryId)).toBeUndefined();
    const archivedView = afterArchive.body.archived.find((category) => category.id === usedCategoryId);
    expect(archivedView).toMatchObject({ transaction_count: 1, is_active: 0 });
    expect(archivedView.archived_at).toEqual(expect.any(String));
    expect(archivedView.user_id).toBeUndefined();
    expect(archivedView.sort).toBeUndefined();

    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/${usedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: 1 })
      .expect(200);

    const afterRestore = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const restoredView = afterRestore.body.expenses.find((category) => category.id === usedCategoryId);
    expect(restoredView).toMatchObject({ is_active: 1 });
    expect(restoredView.archived_at).toBeNull();
    expect(afterRestore.body.archived.find((category) => category.id === usedCategoryId)).toBeUndefined();
  });

  it('archiving a category unlinks it from its limit, and deletes an emptied single-category limit', async () => {
    const createLimited = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Limited', transaction_type: 'expense', icon: 'Other', color: 'slate' })
      .expect(201);
    const limitedCategoryId = createLimited.body.id;

    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/transactions`)
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
      .post(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [limitedCategoryId], amount: '20.00' })
      .expect(201);
    const limitId = createLimit.body.id;

    const beforeDelete = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(beforeDelete.body.expenses.find((category) => category.id === limitedCategoryId).limit).toMatchObject({
      id: limitId,
    });

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${personalSpaceId}/categories/${limitedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ archived: true }));

    const afterArchive = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const archivedView = afterArchive.body.archived.find((category) => category.id === limitedCategoryId);
    expect(archivedView.limit).toBeNull();

    const limitsAfterArchive = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/limits`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(limitsAfterArchive.body.categories.find((limit) => limit.id === limitId)).toBeUndefined();

    // restoring must not resurrect the (now-deleted) limit link
    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/${limitedCategoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_active: 1 })
      .expect(200);

    const afterRestore = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterRestore.body.expenses.find((category) => category.id === limitedCategoryId).limit).toBeNull();
  });

  it('reorders a segment and persists the new order', async () => {
    const createFirst = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Reorder A', transaction_type: 'income', icon: 'Other', color: 'slate' })
      .expect(201);
    const createSecond = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Reorder B', transaction_type: 'income', icon: 'Other', color: 'slate' })
      .expect(201);
    const firstId = createFirst.body.id;
    const secondId = createSecond.body.id;

    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [secondId, firstId] })
      .expect(200);

    const afterReorder = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/categories`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const ids = afterReorder.body.incomes.map((category) => category.id);
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));

    // an id that isn't the caller's own must reject the whole batch
    await request(app.getHttpServer())
      .put(`/api/v1/spaces/${personalSpaceId}/categories/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category_ids: [firstId, 999999999] })
      .expect(403);
  });

  it('creates a group space, invites and revokes a pending member', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    const baseCurrencyId = currencies.body[0].id;

    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Family', type: 'group', currency_id: baseCurrencyId })
      .expect(201);

    groupSpaceId = createResponse.body.id;
    expect(createResponse.body.currency_id).toBeUndefined();
    createdSpaceIds.push(groupSpaceId);

    // closes a pre-existing gap: POST /spaces never seeded categories for
    // any space until Stage 3 - a group space now gets the same 15 default
    // categories plus the hidden system one, immediately, not just personal
    // spaces created at register time
    const groupCategories = await dataSource.getRepository(Category).find({ where: { space_id: groupSpaceId } });
    expect(groupCategories).toHaveLength(16);
    expect(groupCategories.filter((category) => category.is_system === 1)).toHaveLength(1);
    expect(groupCategories.some((category) => category.name === 'Initial balance')).toBe(true);

    const membersAfterCreate = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${groupSpaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(membersAfterCreate.body).toEqual([
      expect.objectContaining({ type: 'member', email: testEmail, role: 'owner', can_remove: false }),
    ]);

    const inviteResponse = await request(app.getHttpServer())
      .post(`/api/v1/spaces/${groupSpaceId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'throwaway@example.com' })
      .expect(201);

    expect(inviteResponse.body.code).toMatch(/^\d{6}$/);

    const membersAfterInvite = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${groupSpaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(membersAfterInvite.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'invite', email: 'throwaway@example.com', can_remove: true }),
      ]),
    );

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${groupSpaceId}/invites/${inviteResponse.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const membersAfterRevoke = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${groupSpaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(membersAfterRevoke.body.find((entry) => entry.type === 'invite')).toBeUndefined();
  });

  it('creates a second personal space and rejects inviting into it', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    const baseCurrencyId = currencies.body[0].id;

    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Savings', type: 'personal', currency_id: baseCurrencyId })
      .expect(201);
    createdSpaceIds.push(createResponse.body.id);

    await request(app.getHttpServer())
      .post('/api/v1/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'E2E Invalid', type: 'personal', currency_id: baseCurrencyId, invites: ['nope@example.com'] })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${createResponse.body.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'nope@example.com' })
      .expect(400);
  });

  it('registers a second user, who cannot delete their only space', async () => {
    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    const baseCurrencyId = currencies.body[0].id;

    const registerResponse = await request(app.getHttpServer())
      .post('/api/v1/users/register')
      .send({ name: 'E2E Second', email: secondTestEmail, password: testPassword, base_currency_id: baseCurrencyId })
      .expect(201);
    secondUserId = registerResponse.body.id;

    const confirmationCodeRepository = dataSource.getRepository(ConfirmationCode);
    const confirmationCode = await confirmationCodeRepository.findOneOrFail({ where: { user_id: secondUserId } });

    await request(app.getHttpServer())
      .post('/api/v1/users/verify-email')
      .send({ email: secondTestEmail, code: confirmationCode.confirmation_code })
      .expect(201);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/users/login')
      .send({ email: secondTestEmail, password: testPassword })
      .expect(201);
    secondUserToken = loginResponse.text;

    const spacesResponse = await request(app.getHttpServer())
      .get('/api/v1/spaces')
      .set('Authorization', `Bearer ${secondUserToken}`)
      .expect(200);
    expect(spacesResponse.body).toHaveLength(1);
    const secondUserPersonalSpaceId = spacesResponse.body[0].id;
    createdSpaceIds.push(secondUserPersonalSpaceId);

    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${secondUserPersonalSpaceId}`)
      .set('Authorization', `Bearer ${secondUserToken}`)
      .expect(400);
  });

  it('the second user accepts an invite and becomes a member of the group space', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${groupSpaceId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: secondTestEmail })
      .expect(201);

    const spaceInviteRepository = dataSource.getRepository(SpaceInvite);
    const invite = await spaceInviteRepository.findOneOrFail({
      where: { space_id: groupSpaceId, email: secondTestEmail },
    });

    // wrong account: the caller's own email must match the invite's email
    await request(app.getHttpServer())
      .post('/api/v1/spaces/invites/accept')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: invite.code })
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/spaces/invites/accept')
      .set('Authorization', `Bearer ${secondUserToken}`)
      .send({ code: invite.code })
      .expect(201);

    const membersResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${groupSpaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(membersResponse.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'member', email: secondTestEmail, role: 'member' })]),
    );
  });

  it('a plain member can create resources in the shared space, but not in a space they do not belong to', async () => {
    // secondUserToken belongs to a plain 'member', not the owner - proves
    // membership, not ownership, is what these routes actually require
    await request(app.getHttpServer())
      .post(`/api/v1/spaces/${groupSpaceId}/wallets`)
      .set('Authorization', `Bearer ${secondUserToken}`)
      .send({ wallet_name: 'Shared', initial_balance: '0.00', design: 'amber' })
      .expect(201);

    // the same member has no membership at all in the first user's personal space
    await request(app.getHttpServer())
      .get(`/api/v1/spaces/${personalSpaceId}/wallets`)
      .set('Authorization', `Bearer ${secondUserToken}`)
      .expect(403);
  });

  it('the owner leaves the group space and ownership transfers to the next member', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/spaces/${groupSpaceId}/members/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const spacesAfterLeaving = await request(app.getHttpServer())
      .get('/api/v1/spaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(spacesAfterLeaving.body.find((space) => space.id === groupSpaceId)).toBeUndefined();

    const membersResponse = await request(app.getHttpServer())
      .get(`/api/v1/spaces/${groupSpaceId}/members`)
      .set('Authorization', `Bearer ${secondUserToken}`)
      .expect(200);
    expect(membersResponse.body).toEqual([
      expect.objectContaining({ type: 'member', email: secondTestEmail, role: 'owner', can_remove: false }),
    ]);
  });
});
