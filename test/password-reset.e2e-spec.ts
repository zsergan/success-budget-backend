import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { type ObjectLiteral, Repository } from 'typeorm';

import { LOCK_USER, overlap, pauseAfterFirstCall } from './support/concurrency';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';
import { type TestApp, createTestApp, createVerifiedMember, deleteUsers, PASSWORD, uniqueEmail } from './support/app';
import { User } from '@entities/user.entity';
import { MailService } from '@modules/mail/mail.service';
import { UsersService } from '@modules/users/users.service';
import { PasswordResetService } from '@modules/password-reset/password-reset.service';
import { hashEmail, passwordResetKey } from '@modules/password-reset/password-reset-secrets';

const NEW_PASSWORD = 'new-secret-42';
const SHARE_USER = '%FROM `users` `user`%SHARE%';

interface ChallengeRow {
  user_id: number | null;
  code_hash: string | null;
  attempts: number;
  expires_at: Date;
  send_attempt_id: number;
  send_status: string | null;
  reset_token_hash: string | null;
}

describe('Password reset (e2e)', () => {
  let testApp: TestApp;
  let key: Buffer;
  let sendPasswordResetCode: jest.SpyInstance;
  const userIds: number[] = [];
  const emails: string[] = [];
  const maildevApiUrl = process.env.MAILDEV_API_URL ?? 'http://127.0.0.1:1080';

  const server = () => testApp.app.getHttpServer();
  const settle = () => testApp.app.get(PasswordResetService).settleDeliveries();
  const requestReset = (email: string) =>
    request(server()).post('/api/v1/users/password-reset/request').send({ email });
  const verify = (email: string, code: string) =>
    request(server()).post('/api/v1/users/password-reset/verify').send({ email, code });
  const complete = (resetToken: string, password = NEW_PASSWORD) =>
    request(server()).post('/api/v1/users/password-reset/complete').send({ reset_token: resetToken, password });
  const login = (email: string, password: string) =>
    request(server()).post('/api/v1/users/login').send({ email, password });
  const profile = (token: string) =>
    request(server()).get('/api/v1/users/profile').set('Authorization', `Bearer ${token}`);

  function address(prefix: string): string {
    const email = uniqueEmail(`password-reset-${prefix}`);
    emails.push(email);
    return email;
  }

  async function verifiedAccount(prefix: string): Promise<string> {
    const member = await createVerifiedMember(testApp, `password-reset-${prefix}`);
    userIds.push(member.userId);
    const [user] = await testApp.dataSource.query('SELECT email FROM users WHERE id = ?', [member.userId]);
    emails.push(user.email);
    return user.email;
  }

  async function challenge(email: string): Promise<ChallengeRow | undefined> {
    const [row] = await testApp.dataSource.query('SELECT * FROM password_reset_challenges WHERE email_hash = ?', [
      hashEmail(key, email),
    ]);
    return row;
  }

  async function sentCode(email: string): Promise<string> {
    await settle();
    const calls = sendPasswordResetCode.mock.calls.filter(([to]) => to === email);
    return calls[calls.length - 1][1];
  }

  async function authorize(email: string): Promise<string> {
    await requestReset(email).expect(202);
    const authorized = await verify(email, await sentCode(email)).expect(200);
    return authorized.body.reset_token;
  }

  async function authVersion(email: string): Promise<number> {
    const [user] = await testApp.dataSource.query('SELECT auth_version FROM users WHERE email = ?', [email]);
    return user.auth_version;
  }

  const otherCode = (code: string) => (code === '000000' ? '000001' : '000000');

  async function moveBack(email: string, column: 'last_requested_at' | 'expires_at', ms: number) {
    await testApp.dataSource.query(
      `UPDATE password_reset_challenges SET ${column} = ${column} - INTERVAL ? MICROSECOND WHERE email_hash = ?`,
      [ms * 1000, hashEmail(key, email)],
    );
  }

  beforeAll(async () => {
    testApp = await createTestApp();
    key = passwordResetKey(testApp.app.get(ConfigService).getOrThrow('JWT_SECRET'));
  });

  beforeEach(() => {
    testApp.resetThrottling();
    sendPasswordResetCode = jest.spyOn(testApp.app.get(MailService), 'sendPasswordResetCode').mockResolvedValue();
  });

  afterEach(async () => {
    await settle();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (emails.length) {
        await testApp.dataSource.query('DELETE FROM password_reset_challenges WHERE email_hash IN (?)', [
          emails.map((email) => hashEmail(key, email)),
        ]);
      }
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  it('answers verified, unverified and unknown addresses alike and emails only the verified one', async () => {
    const verified = await verifiedAccount('verified');
    const unverified = address('unverified');
    const unknown = address('unknown');
    const user = await testApp.app.get(UsersService).register({
      name: 'E2E',
      email: unverified,
      password: PASSWORD,
      base_currency_id: testApp.currencyId,
    });
    userIds.push(user.id);

    for (const email of [verified, unverified, unknown]) {
      testApp.resetThrottling();
      const accepted = await requestReset(email).expect(202);
      expect(accepted.body).toEqual({
        message: 'If this email belongs to a verified account, a password reset code has been sent',
        resend_after_seconds: 60,
      });

      const refused = await requestReset(email).expect(429);
      expect(refused.body.code).toBe('PASSWORD_RESET_RATE_LIMITED');
      expect(refused.headers['retry-after']).toBe('60');
      expect(refused.body.retryAfterSeconds).toBe(60);
    }

    await settle();
    expect(sendPasswordResetCode.mock.calls.map(([to]) => to)).toEqual([verified]);
    expect(await challenge(verified)).toMatchObject({ code_hash: expect.any(String), send_status: 'sent' });
    for (const email of [unverified, unknown]) {
      expect(await challenge(email)).toMatchObject({ user_id: null, code_hash: null, send_status: null });
    }

    testApp.resetThrottling();
    await verify(unverified, '123456').expect(400, /PASSWORD_RESET_CODE_INVALID/);
    await verify(unknown, '123456').expect(400, /PASSWORD_RESET_CODE_INVALID/);
    await verify(address('never-requested'), '123456').expect(400, /PASSWORD_RESET_CODE_UNUSABLE/);
  });

  it('answers with the documented schemas', async () => {
    const document = createOpenApiDocument(testApp.app);
    const email = await verifiedAccount('schema');

    const accepted = await requestReset(email).expect(202);
    const requestPath = Object.keys(document.paths).find((path) => path.endsWith('/password-reset/request'))!;
    const acceptedResponse = document.paths[requestPath].post!.responses['202'] as {
      content: Record<string, { schema: object }>;
    };
    expect(schemaErrors(document, acceptedResponse.content['application/json'].schema, accepted.body)).toEqual([]);

    const authorized = await verify(email, await sentCode(email)).expect(200);
    expect(
      schemaErrors(document, okResponseSchema(document, '/password-reset/verify', 'post'), authorized.body),
    ).toEqual([]);
  });

  it('documents every status of the three routes, Retry-After on 429 and the password rules', () => {
    const document = createOpenApiDocument(testApp.app);
    const operation = (route: string) =>
      document.paths[Object.keys(document.paths).find((path) => path.endsWith(`/password-reset/${route}`))!].post!;
    const expected = { request: ['202', '400', '429'], verify: ['200', '400', '429'], complete: ['204', '400', '429'] };

    for (const [route, statuses] of Object.entries(expected)) {
      const responses = operation(route).responses as Record<string, { headers?: Record<string, unknown> }>;
      expect(Object.keys(responses).sort()).toEqual(statuses);
      expect(responses['429'].headers).toHaveProperty('Retry-After');
    }

    expect(document.components!.schemas!.CompletePasswordResetDto).toMatchObject({
      required: ['reset_token', 'password'],
      properties: { password: { minLength: 8, maxLength: 72 } },
    });
  });

  it('exchanges the code for a reset token that is replayable and is not an access token', async () => {
    const email = await verifiedAccount('token');
    await requestReset(email).expect(202);
    const code = await sentCode(email);

    const first = await verify(email, code).expect(200);
    expect(first.body).toEqual({ reset_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expires_in_seconds: 600 });

    const repeat = await verify(email, code).expect(200);
    expect(repeat.body.reset_token).toBe(first.body.reset_token);

    await request(server())
      .get('/api/v1/users/profile')
      .set('Authorization', `Bearer ${first.body.reset_token}`)
      .expect(401);
    expect((await challenge(email))!.reset_token_hash).not.toContain(first.body.reset_token);
  });

  it('persists wrong codes and ends the challenge with the fifth', async () => {
    const email = await verifiedAccount('attempts');
    await requestReset(email).expect(202);
    const code = await sentCode(email);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await verify(email, otherCode(code)).expect(400, /PASSWORD_RESET_CODE_INVALID/);
    }
    await verify(email, otherCode(code)).expect(400, /PASSWORD_RESET_CODE_UNUSABLE/);
    testApp.resetThrottling();
    await verify(email, code).expect(400, /PASSWORD_RESET_CODE_UNUSABLE/);

    expect((await challenge(email))!.attempts).toBe(5);
  });

  it('refuses a malformed code without using an attempt', async () => {
    const email = await verifiedAccount('malformed');
    await requestReset(email).expect(202);

    await verify(email, '12345').expect(400, /VALIDATION_FAILED/);

    expect((await challenge(email))!.attempts).toBe(0);
  });

  it('refuses an expired code', async () => {
    const email = await verifiedAccount('expired');
    await requestReset(email).expect(202);
    const code = await sentCode(email);
    await moveBack(email, 'expires_at', 30 * 60_000);

    await verify(email, code).expect(400, /PASSWORD_RESET_CODE_UNUSABLE/);
  });

  it('resends a new code after the cooldown and keeps the expiry and used attempts', async () => {
    const email = await verifiedAccount('resend');
    await requestReset(email).expect(202);
    const first = await sentCode(email);
    await verify(email, otherCode(first)).expect(400);
    const before = (await challenge(email))!;
    await moveBack(email, 'last_requested_at', 60_000);

    await requestReset(email).expect(202);
    const second = await sentCode(email);

    expect(sendPasswordResetCode).toHaveBeenLastCalledWith(email, second, before.expires_at);
    expect(await challenge(email)).toMatchObject({ attempts: 1, expires_at: before.expires_at, send_attempt_id: 2 });
    if (second !== first) {
      await verify(email, first).expect(400, /PASSWORD_RESET_CODE_INVALID/);
    }
    await verify(email, second).expect(200);
  });

  it('records an SMTP failure without changing the response', async () => {
    const email = await verifiedAccount('smtp-failure');
    sendPasswordResetCode.mockRejectedValue(new ServiceUnavailableException());

    await requestReset(email).expect(202);
    await settle();

    expect((await challenge(email))!.send_status).toBe('failed');
  });

  it('keeps the outcome of a newer send when an older, slower one fails afterwards', async () => {
    const email = await verifiedAccount('stale-send');
    let failFirst!: (error: Error) => void;
    sendPasswordResetCode.mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = reject)));

    await requestReset(email).expect(202);
    await moveBack(email, 'last_requested_at', 60_000);
    await requestReset(email).expect(202);
    const deadline = Date.now() + 5000;
    while ((await challenge(email))!.send_status !== 'sent' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await challenge(email)).toMatchObject({ send_attempt_id: 2, send_status: 'sent' });

    failFirst(new ServiceUnavailableException());
    await settle();

    expect((await challenge(email))!.send_status).toBe('sent');
  });

  it.each(['verified', 'unknown'])('accepts one of concurrent first requests for a %s address', async (kind) => {
    const email = kind === 'verified' ? await verifiedAccount('concurrent') : address('concurrent');

    const responses = await Promise.all(Array.from({ length: 5 }, () => requestReset(email)));

    expect(responses.map((response) => response.status).sort()).toEqual([202, 429, 429, 429, 429]);
    const [{ count }] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS count FROM password_reset_challenges WHERE email_hash = ?',
      [hashEmail(key, email)],
    );
    expect(Number(count)).toBe(1);
    await settle();
    expect(sendPasswordResetCode).toHaveBeenCalledTimes(kind === 'verified' ? 1 : 0);
  });

  it('counts concurrent wrong codes exactly', async () => {
    const email = await verifiedAccount('concurrent-wrong');
    await requestReset(email).expect(202);
    const code = await sentCode(email);

    const responses = await Promise.all(Array.from({ length: 5 }, () => verify(email, otherCode(code))));

    expect(responses.map((response) => response.body.code).sort()).toEqual([
      'PASSWORD_RESET_CODE_INVALID',
      'PASSWORD_RESET_CODE_INVALID',
      'PASSWORD_RESET_CODE_INVALID',
      'PASSWORD_RESET_CODE_INVALID',
      'PASSWORD_RESET_CODE_UNUSABLE',
    ]);
    expect((await challenge(email))!.attempts).toBe(5);
  });

  it('gives concurrent verifications of the right code the same token', async () => {
    const email = await verifiedAccount('concurrent-right');
    await requestReset(email).expect(202);
    const code = await sentCode(email);

    const responses = await Promise.all(Array.from({ length: 3 }, () => verify(email, code)));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(new Set(responses.map((response) => response.body.reset_token)).size).toBe(1);
  });

  it('delivers a real email with the code and its remaining lifetime', async () => {
    jest.restoreAllMocks();
    const email = await verifiedAccount('delivery');

    await requestReset(email).expect(202);
    await settle();

    let message: { id: string; text: string } | undefined;
    const deadline = Date.now() + 10_000;
    while (!message && Date.now() < deadline) {
      const response = await fetch(`${maildevApiUrl}/api/email`);
      const messages: { id: string; text: string; subject: string; to?: { address: string }[] }[] =
        await response.json();
      message = messages.find((candidate) => candidate.to?.some((recipient) => recipient.address === email));
      if (!message) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    expect(message).toBeDefined();
    expect(message!.text).toContain('expires in 30 minutes');
    expect(message!.text).toContain('Only the code from the most recent email works.');
    const code = /password reset code is (\d{6})/.exec(message!.text)![1];
    await verify(email, code).expect(200);
    await fetch(`${maildevApiUrl}/api/email/${message!.id}`, { method: 'DELETE' }).catch(() => undefined);
  });

  describe('complete', () => {
    it('replaces the password, ends every session and signs nobody in', async () => {
      const email = await verifiedAccount('complete');
      const session = (await login(email, PASSWORD).expect(201)).text;
      expect(jwt.decode(session)).toMatchObject({ ver: 1 });
      const token = await authorize(email);

      const completed = await complete(token).expect(204);

      expect(completed.text).toBe('');
      await profile(session).expect(401);
      testApp.resetThrottling();
      await login(email, PASSWORD).expect(401, /INVALID_CREDENTIALS/);
      const fresh = (await login(email, NEW_PASSWORD).expect(201)).text;
      expect(jwt.decode(fresh)).toMatchObject({ ver: 2 });
      await profile(fresh).expect(200);
      expect(await challenge(email)).toMatchObject({ code_hash: null, reset_token_hash: null });
    });

    it('keeps tokens issued without a version valid until the reset', async () => {
      const email = await verifiedAccount('legacy');
      const [user] = await testApp.dataSource.query('SELECT id FROM users WHERE email = ?', [email]);
      const legacy = jwt.sign({ id: user.id }, testApp.app.get(ConfigService).getOrThrow<string>('JWT_SECRET'), {
        expiresIn: 60 * 60,
      });

      await profile(legacy).expect(200);
      await complete(await authorize(email)).expect(204);
      await profile(legacy).expect(401);
    });

    it('refuses a replay, the accepted code and the old token once the reset is done', async () => {
      const email = await verifiedAccount('replay');
      await requestReset(email).expect(202);
      const code = await sentCode(email);
      const token = (await verify(email, code).expect(200)).body.reset_token;
      await complete(token).expect(204);

      await complete(token, 'another-secret-7').expect(400, /PASSWORD_RESET_AUTHORIZATION_INVALID/);
      await verify(email, code).expect(400, /PASSWORD_RESET_CODE_UNUSABLE/);
      testApp.resetThrottling();
      await login(email, 'another-secret-7').expect(401);
      await login(email, NEW_PASSWORD).expect(201);
      expect(await authVersion(email)).toBe(2);
    });

    it('lets exactly one of concurrent completions change the password', async () => {
      const email = await verifiedAccount('concurrent-complete');
      const token = await authorize(email);
      const passwords = ['first-secret-1', 'second-secret-2', 'third-secret-3'];

      const responses = await Promise.all(passwords.map((password) => complete(token, password)));

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 204)).toHaveLength(1);
      expect(statuses.filter((status) => status === 400)).toHaveLength(2);
      expect(await authVersion(email)).toBe(2);
      testApp.resetThrottling();
      const winner = passwords[statuses.indexOf(204)];
      for (const password of passwords) {
        await login(email, password).expect(password === winner ? 201 : 401);
      }
    });

    it('refuses a login that waited on a reset in progress', async () => {
      const email = await verifiedAccount('race-reset-first');
      const token = await authorize(email);
      const checkpoint = pauseAfterFirstCall(
        Repository.prototype,
        'update',
        (self) => (self as Repository<ObjectLiteral>).target === User,
      );

      const [completed, raced] = await overlap(
        testApp.dataSource,
        checkpoint,
        SHARE_USER,
        () => complete(token),
        () => login(email, PASSWORD),
      );

      expect(completed.status).toBe(204);
      expect(raced.status).toBe(401);
      expect(raced.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('revokes the session of a login that finished before the reset', async () => {
      const email = await verifiedAccount('race-login-first');
      const token = await authorize(email);
      const usersService = testApp.app.get(UsersService) as unknown as { generateAccessToken(user: User): string };
      const checkpoint = pauseAfterFirstCall(usersService, 'generateAccessToken');

      const [loggedIn, completed] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_USER,
        () => login(email, PASSWORD),
        () => complete(token),
      );

      expect(loggedIn.status).toBe(201);
      expect(completed.status).toBe(204);
      await profile(loggedIn.text).expect(401);
    });

    it.each([
      ['too short', 'abc1234'],
      ['without a digit', 'password'],
      ['without a letter', '12345678'],
      ['over 72 bytes', 'a1' + 'ж'.repeat(36)],
    ])('refuses a password %s without using the token', async (_case, password) => {
      const email = await verifiedAccount('weak');
      const token = await authorize(email);

      const refused = await complete(token, password).expect(400);

      expect(refused.body.code).toBe('VALIDATION_FAILED');
      await complete(token).expect(204);
    });

    it('refuses an unknown or expired token', async () => {
      const email = await verifiedAccount('expired-token');
      const token = await authorize(email);

      await complete('x'.repeat(43)).expect(400, /PASSWORD_RESET_AUTHORIZATION_INVALID/);
      await testApp.dataSource.query(
        'UPDATE password_reset_challenges SET reset_token_expires_at = NOW(3) WHERE email_hash = ?',
        [hashEmail(key, email)],
      );
      await complete(token).expect(400, /PASSWORD_RESET_AUTHORIZATION_INVALID/);
      expect(await authVersion(email)).toBe(1);
    });

    it('refuses a token replaced by a newer request', async () => {
      const email = await verifiedAccount('replaced');
      const token = await authorize(email);
      await moveBack(email, 'last_requested_at', 60_000);

      await requestReset(email).expect(202);

      await complete(token).expect(400, /PASSWORD_RESET_AUTHORIZATION_INVALID/);
    });
  });

  it('still signs users in after registration and email verification', async () => {
    const sendConfirmationCode = jest.spyOn(testApp.app.get(MailService), 'sendConfirmationCode').mockResolvedValue();
    const email = address('registration');
    const registered = await request(server())
      .post('/api/v1/users/register')
      .send({ name: 'E2E', email, password: PASSWORD, base_currency_id: testApp.currencyId })
      .expect(201);
    userIds.push(registered.body.id);
    const [, code] = sendConfirmationCode.mock.calls[0];

    const verified = await request(server()).post('/api/v1/users/verify-email').send({ email, code }).expect(201);

    expect(jwt.decode(verified.text)).toMatchObject({ id: registered.body.id, ver: 1 });
    await profile(verified.text).expect(200);
    await profile((await login(email, PASSWORD).expect(201)).text).expect(200);
  });
});
