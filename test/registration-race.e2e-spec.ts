import request from 'supertest';
import { ObjectLiteral, Repository } from 'typeorm';

import { User } from '@entities/user.entity';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { MailService } from '@modules/mail/mail.service';
import { UsersService } from '@modules/users/users.service';
import { ConfirmationType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { createTestApp, deleteUsers, PASSWORD, TestApp, uniqueEmail } from './support/app';
import { INSERT_USER, LOCK_USER, overlap, pauseAfterFirstCall } from './support/concurrency';

describe('Registration races (e2e)', () => {
  let testApp: TestApp;
  let otherCurrencyId: number;
  const emails: string[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
    const [other] = await testApp.dataSource.query('SELECT id FROM currencies WHERE id <> ? ORDER BY id LIMIT 1', [
      testApp.currencyId,
    ]);
    otherCurrencyId = other.id;
  });

  beforeEach(() => {
    testApp.resetThrottling();
    jest.spyOn(testApp.app.get(MailService), 'sendConfirmationCode').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (emails.length) {
        const users: { id: number }[] = await testApp.dataSource.query('SELECT id FROM users WHERE email IN (?)', [
          emails,
        ]);
        await deleteUsers(
          testApp.dataSource,
          users.map((user) => user.id),
        );
      }
    } finally {
      await testApp.app.close();
    }
  });

  function newEmail(): string {
    const email = uniqueEmail('registration');
    emails.push(email);
    return email;
  }

  function register(email: string, overrides: object = {}) {
    return request(testApp.app.getHttpServer())
      .post('/api/v1/users/register')
      .send({ name: 'Original', email, password: PASSWORD, base_currency_id: testApp.currencyId, ...overrides });
  }

  function verify(email: string, code: string) {
    return request(testApp.app.getHttpServer()).post('/api/v1/users/verify-email').send({ email, code });
  }

  async function accounts(email: string): Promise<{ users: number; spaces: number; codes: number }> {
    const [row] = await testApp.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE email = ?) AS users,
         (SELECT COUNT(*) FROM space_members m INNER JOIN users u ON u.id = m.user_id WHERE u.email = ?) AS spaces,
         (SELECT COUNT(*) FROM confirmation_codes c INNER JOIN users u ON u.id = c.user_id WHERE u.email = ?) AS codes`,
      [email, email, email],
    );
    return { users: Number(row.users), spaces: Number(row.spaces), codes: Number(row.codes) };
  }

  async function storedAccount(email: string): Promise<{ name: string; currency_id: number; email_verified: number }> {
    const [row] = await testApp.dataSource.query(
      `SELECT u.name, s.currency_id, u.email_verified FROM users u
       INNER JOIN space_members m ON m.user_id = u.id
       INNER JOIN spaces s ON s.id = m.space_id
       WHERE u.email = ?`,
      [email],
    );
    return row;
  }

  async function registerWithCode(email: string): Promise<string> {
    const user = await testApp.app
      .get(UsersService)
      .register({ name: 'Original', email, password: PASSWORD, base_currency_id: testApp.currencyId });
    const { code } = await testApp.app.get(ConfirmationCodesService).reserveSend(user.id, ConfirmationType.EMAIL);
    return code;
  }

  it('creates one user and one personal space for two overlapping first registrations', async () => {
    const email = newEmail();
    const checkpoint = pauseAfterFirstCall(
      Repository.prototype,
      'save',
      (self) => (self as Repository<ObjectLiteral>).target === User,
    );

    const [first, second] = await overlap(
      testApp.dataSource,
      checkpoint,
      INSERT_USER,
      () => register(email),
      () => register(email, { name: 'Second' }),
    );

    // the loser continues as a re-registration of the winner's account; its
    // code reservation then either sends or hits the resend cooldown
    expect(first.status).toBe(201);
    expect([201, 429]).toContain(second.status);
    if (second.status === 201) {
      expect(second.body.id).toBe(first.body.id);
    } else {
      expect(second.body.message).toBe(ErrorMessages.CONFIRMATION_EMAIL_RATE_LIMITED);
    }
    expect(await accounts(email)).toEqual({ users: 1, spaces: 1, codes: 1 });
    expect(await storedAccount(email)).toMatchObject({ name: 'Second', email_verified: 0 });
  });

  it('treats an email differing only in case as the same account', async () => {
    const email = newEmail();

    const first = await register(email);
    const shouting = await register(email.toUpperCase(), { name: 'Shouting' });

    expect(first.status).toBe(201);
    expect(shouting.status).toBe(201);
    expect(shouting.body).toMatchObject({ id: first.body.id, email, name: 'Shouting' });
    expect(await accounts(email)).toEqual({ users: 1, spaces: 1, codes: 1 });
  });

  it('does not change a verified account on re-registration', async () => {
    const email = newEmail();
    const code = await registerWithCode(email);
    expect((await verify(email, code)).status).toBe(201);

    const takeover = await register(email, {
      name: 'Takeover',
      password: 'Other#2026',
      base_currency_id: otherCurrencyId,
    });

    expect(takeover.status).toBe(400);
    expect(takeover.body.message).toBe(ErrorMessages.EMAIL_ALREADY_EXISTS);
    expect(await storedAccount(email)).toEqual({
      name: 'Original',
      currency_id: testApp.currencyId,
      email_verified: 1,
    });
    await expect(testApp.app.get(UsersService).login({ email, password: PASSWORD })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('does not let a re-registration overlapping the confirmation change the verified account', async () => {
    const email = newEmail();
    const code = await registerWithCode(email);
    const checkpoint = pauseAfterFirstCall(testApp.app.get(ConfirmationCodesService), 'lockActive');

    const [verification, takeover] = await overlap(
      testApp.dataSource,
      checkpoint,
      LOCK_USER,
      () => verify(email, code),
      () => register(email, { name: 'Takeover', password: 'Other#2026', base_currency_id: otherCurrencyId }),
    );

    expect(verification.status).toBe(201);
    expect(takeover.status).toBe(400);
    expect(takeover.body.message).toBe(ErrorMessages.EMAIL_ALREADY_EXISTS);
    expect(await storedAccount(email)).toEqual({
      name: 'Original',
      currency_id: testApp.currencyId,
      email_verified: 1,
    });
    expect(await accounts(email)).toEqual({ users: 1, spaces: 1, codes: 1 });
    await expect(testApp.app.get(UsersService).login({ email, password: PASSWORD })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('does not reserve an email code for an account verified after the caller checked it', async () => {
    const email = newEmail();
    const code = await registerWithCode(email);
    expect((await verify(email, code)).status).toBe(201);
    const [user] = await testApp.dataSource.query('SELECT id FROM users WHERE email = ?', [email]);

    await expect(
      testApp.app.get(ConfirmationCodesService).reserveSend(user.id, ConfirmationType.EMAIL),
    ).rejects.toMatchObject({ message: ErrorMessages.EMAIL_ALREADY_EXISTS });

    expect(await accounts(email)).toEqual({ users: 1, spaces: 1, codes: 1 });
  });
});
