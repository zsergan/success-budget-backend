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
    if (userId) {
      // Limits must go first: limits.category_id is RESTRICT (phase 13), and
      // MySQL's cascade engine doesn't resolve categories.user_id CASCADE
      // and limits.category_id RESTRICT in the order that would make a
      // plain `DELETE FROM users` work when a category-scoped limit exists -
      // it hits the RESTRICT before the sibling CASCADE removes the limit
      // that's blocking it. No user-delete endpoint exists in the app today
      // (this is a raw-SQL-only situation), but this test creates a
      // category-scoped limit, so it has to clean that up explicitly first.
      await dataSource.query('DELETE FROM limits WHERE user_id = ?', [userId]);
      // onDelete: CASCADE takes the wallet, categories, and confirmation code with it.
      await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
    }
    await app.close();
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

  it('creates a category and moves it to the front of its list', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hobbies', transaction_type: 'expense', icon: 'brush', color: '#abcdef' })
      .expect(201);

    const categoryId = createResponse.body.id;

    await request(app.getHttpServer())
      .put(`/api/v1/categories/move-forward/${categoryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const categoriesResponse = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(categoriesResponse.body.expenses[0].id).toBe(categoryId);
  });

  it('creates transactions and atomically updates the wallet balance', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const salaryCategoryId = categoriesResponse.body.incomes.find((category) => category.name === 'Salary').id;
    const groceriesCategoryId = categoriesResponse.body.expenses.find((category) => category.name === 'Groceries').id;

    await request(app.getHttpServer())
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

    await request(app.getHttpServer())
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        wallet_id: walletId,
        category_id: groceriesCategoryId,
        transaction_type: 'expense',
        amount: '120.50',
        timestamp: new Date().toISOString(),
        description: 'e2e groceries',
      })
      .expect(201);

    const walletsResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const wallet = walletsResponse.body.find((entry) => entry.wallet.id === walletId);
    expect(Number(wallet.wallet.balance)).toBe(379.5);
    expect(Number(wallet.total_income)).toBe(500);
    expect(Number(wallet.total_spend)).toBe(120.5);
  });

  it('creates a limit and reports spending against it', async () => {
    const categoriesResponse = await request(app.getHttpServer())
      .get('/api/v1/categories')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const groceriesCategoryId = categoriesResponse.body.expenses.find((category) => category.name === 'Groceries').id;

    await request(app.getHttpServer())
      .post('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .send({ category_id: groceriesCategoryId, amount: '200.00' })
      .expect(201);

    const limitsResponse = await request(app.getHttpServer())
      .get('/api/v1/limits')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const groceriesLimit = limitsResponse.body.limits.find((limit) => limit.category.id === groceriesCategoryId);
    expect(Number(groceriesLimit.spent)).toBe(120.5);
    expect(groceriesLimit.in_percent).toBe(60);
  });
});
