import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';

import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';
import { type TestApp, createTestApp, createVerifiedMember, deleteUsers, PASSWORD, uniqueEmail } from './support/app';
import { MailService } from '@modules/mail/mail.service';
import { UsersService } from '@modules/users/users.service';
import { PasswordResetService } from '@modules/password-reset/password-reset.service';
import { hashEmail, passwordResetKey } from '@modules/password-reset/password-reset-secrets';

interface ChallengeRow {
  user_id: number | null;
  code_hash: string | null;
  attempts: number;
  expires_at: Date;
  send_attempt_id: number;
  send_status: string | null;
  reset_token_hash: string | null;
}

describe('Password reset request and verification (e2e)', () => {
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
      await testApp.dataSource.query('DELETE FROM password_reset_challenges WHERE email_hash IN (?)', [
        emails.map((email) => hashEmail(key, email)),
      ]);
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
});
