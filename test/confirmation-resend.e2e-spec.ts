import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { User } from '@entities/user.entity';
import { MailService } from '@modules/mail/mail.service';
import { CONFIRMATION_CODE_RESEND_COOLDOWN_MS } from '@shared/constants';

// Covers the resend-after-SMTP-failure bug: last_sent_at used to be updated
// *before* delivery was confirmed, so a failed send within the cooldown
// silently looked like a success on the next request. reserveSend() now
// tracks attempts and confirmed sends separately (see ConfirmationCodesService).
describe('Confirmation code resend on SMTP failure (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let sendConfirmationCode: jest.Mock;
  const testPassword = 'DevTest#2026';
  const createdUserIds: number[] = [];
  let baseCurrencyId: number;

  beforeAll(async () => {
    sendConfirmationCode = jest.fn();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({ sendConfirmationCode })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage = moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    const currencies = await request(app.getHttpServer()).get('/api/v1/currencies');
    baseCurrencyId = currencies.body[0].id;
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length) {
        const members: { space_id: number }[] = await dataSource.query(
          'SELECT space_id FROM space_members WHERE user_id IN (?)',
          [createdUserIds],
        );
        const spaceIds = members.map((member) => member.space_id);
        if (spaceIds.length) {
          await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
        }
        await dataSource.query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
      }
    } finally {
      await app.close();
    }
  });

  beforeEach(() => {
    sendConfirmationCode.mockReset();
    // this suite makes more than 5 (the route's own @Throttle limit) POST
    // /users/register calls well within 60s - clear the shared in-memory
    // counter between tests so it tests resend behavior, not the unrelated
    // request-rate limiter.
    throttlerStorage.storage.clear();
  });

  const register = (email: string) =>
    request(app.getHttpServer())
      .post('/api/v1/users/register')
      .send({ name: 'Resend Test', email, password: testPassword, base_currency_id: baseCurrencyId });

  const getCode = (userId: number) =>
    dataSource.getRepository(ConfirmationCode).findOneOrFail({ where: { user_id: userId } });

  it('sends on a fresh registration and records the attempt as confirmed sent', async () => {
    const email = `resend-ok-${Date.now()}@example.com`;
    sendConfirmationCode.mockResolvedValue(undefined);

    const response = await register(email).expect(201);
    createdUserIds.push(response.body.id);

    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);
    const code = await getCode(response.body.id);
    expect(code.send_status).toBe('sent');
    expect(code.last_sent_at).not.toBeNull();
  });

  it('rejects an immediate retry after an SMTP failure with 429/Retry-After, then actually resends once the cooldown passes', async () => {
    const email = `resend-fail-${Date.now()}@example.com`;
    // MailService itself always turns an SMTP error into a 503 (see
    // mail.service.ts) - mirror that contract here rather than a raw Error.
    sendConfirmationCode.mockRejectedValueOnce(new ServiceUnavailableException('smtp down'));

    await register(email).expect(503);

    const user = await dataSource.getRepository(User).findOneOrFail({ where: { email } });
    createdUserIds.push(user.id);

    const codeAfterFailure = await getCode(user.id);
    expect(codeAfterFailure.send_status).toBe('failed');
    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);

    // still within the cooldown - must not silently succeed and must not
    // trigger a second SMTP attempt
    const immediateRetry = await register(email).expect(429);
    expect(immediateRetry.headers['retry-after']).toBeDefined();
    expect(Number(immediateRetry.headers['retry-after'])).toBeGreaterThan(0);
    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);

    // fast-forward past the cooldown without an actual 60s wait
    await dataSource.query('UPDATE confirmation_codes SET last_attempted_at = ? WHERE id = ?', [
      new Date(Date.now() - CONFIRMATION_CODE_RESEND_COOLDOWN_MS - 1000),
      codeAfterFailure.id,
    ]);

    sendConfirmationCode.mockResolvedValueOnce(undefined);
    const afterCooldown = await register(email).expect(201);
    expect(afterCooldown.body.id).toBe(user.id);
    expect(sendConfirmationCode).toHaveBeenCalledTimes(2);

    const finalCode = await getCode(user.id);
    expect(finalCode.send_status).toBe('sent');
    // same code, not a new one - the 10-minute expiry is not reset by a resend
    expect(finalCode.confirmation_code).toBe(codeAfterFailure.confirmation_code);
    expect(finalCode.id).toBe(codeAfterFailure.id);
  });

  it('does not resend, and does not fail, when the previous attempt already succeeded within the cooldown', async () => {
    const email = `resend-success-${Date.now()}@example.com`;
    sendConfirmationCode.mockResolvedValue(undefined);

    const first = await register(email).expect(201);
    createdUserIds.push(first.body.id);
    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);

    const second = await register(email).expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);
  });

  it('serializes two concurrent registrations for the same already-unverified user into exactly one send attempt', async () => {
    const email = `resend-concurrent-${Date.now()}@example.com`;

    // seed the user first (sequentially), then wipe its confirmation code so
    // both concurrent requests below race to create the *first* one - the
    // scenario a client's retry logic or a double-tap on "resend" produces.
    sendConfirmationCode.mockResolvedValueOnce(undefined);
    const seed = await register(email).expect(201);
    createdUserIds.push(seed.body.id);
    await dataSource.getRepository(ConfirmationCode).delete({ user_id: seed.body.id });
    sendConfirmationCode.mockReset();
    sendConfirmationCode.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 150)));

    const [first, second] = await Promise.all([register(email), register(email)]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([201, 429]);
    const denied = first.status === 201 ? second : first;
    expect(denied.headers['retry-after']).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 200)); // let the in-flight send settle
    expect(sendConfirmationCode).toHaveBeenCalledTimes(1);

    const rows = await dataSource.getRepository(ConfirmationCode).find({ where: { user_id: seed.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].send_status).toBe('sent');
  });
});
