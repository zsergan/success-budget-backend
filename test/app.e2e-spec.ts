import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { ConfirmationCode } from '../src/entities/confirmation-codes.entity';

describe('App (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  const testEmail = `e2e-${Date.now()}@example.com`;
  const testPassword = 'DevTest#2026';
  let userId: number;

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

    const token = loginResponse.text;
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
  });
});
