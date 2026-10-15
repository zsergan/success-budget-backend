import { ServiceUnavailableException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { PasswordResetService, PASSWORD_RESET_REQUESTED_MESSAGE } from './password-reset.service';
import { hashEmail, hashResetToken, passwordResetKey } from './password-reset-secrets';
import { PasswordResetChallenge } from '@entities/password-reset-challenge.entity';
import { User } from '@entities/user.entity';
import type { MailService } from '@modules/mail/mail.service';
import { ApiException } from '@shared/api.exception';
import { ConfirmationCodeSendStatus } from '@shared/enums';
import { RetryAfterException } from '@shared/retry-after.exception';
import { buildConfigService, buildUser } from '@testing';

const JWT_SECRET = 'test-secret-value-for-reset';
const START = new Date('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;
const EMAIL = 'user@example.com';
const ACCENTED = 'üser@example.com';

jest.mock('bcrypt', () => ({ hash: async (password: string) => `bcrypt(${password})` }));

// One user and one challenge row, as the service sees them through its
// transaction manager; locks are not modelled. Every address finds the user,
// as a collation that equates spellings would.
class FakeStore {
  user: User | null = buildUser({ id: 3, email: EMAIL, email_verified: 1 });
  challenge: PasswordResetChallenge | null = null;
  insertFailures: Error[] = [];

  private queryBuilder(entity: unknown) {
    const builder = {
      setLock: () => builder,
      where: () => builder,
      getOne: async () => {
        if (entity === User) {
          return this.user;
        }

        return this.challenge ? { ...this.challenge } : null;
      },
    };

    return builder;
  }

  readonly manager = {
    createQueryBuilder: (entity: unknown) => this.queryBuilder(entity),
    getRepository: (entity: unknown) => ({
      update: async (_id: unknown, fields: Partial<PasswordResetChallenge> | Partial<User>) => {
        Object.assign(entity === User ? this.user! : this.challenge!, fields);
      },
      insert: async (fields: Partial<PasswordResetChallenge>) => {
        const failure = this.insertFailures.shift();

        if (failure) {
          throw failure;
        }

        this.challenge = Object.assign(new PasswordResetChallenge(), { id: '11', ...fields });
        return { identifiers: [{ id: '11' }] };
      },
    }),
  };

  readonly dataSource = {
    transaction: jest.fn((_level: string, work: (manager: unknown) => Promise<unknown>) => work(this.manager)),
  };

  readonly challengeRepository = {
    findOne: jest.fn(async ({ where }: { where: { reset_token_hash: string } }) =>
      this.challenge?.reset_token_hash === where.reset_token_hash ? { ...this.challenge } : null,
    ),
    update: jest.fn(
      async (criteria: { id: string; send_attempt_id: number }, fields: Partial<PasswordResetChallenge>) => {
        if (this.challenge && this.challenge.send_attempt_id === criteria.send_attempt_id) {
          Object.assign(this.challenge, fields);
        }
      },
    ),
  };
}

describe('PasswordResetService', () => {
  let store: FakeStore;
  let sendResetEmail: jest.Mock<Promise<void>, [string, string, Date]>;
  let service: PasswordResetService;

  const sentCodes = () => sendResetEmail.mock.calls.map(([, code]) => code);
  const lastCode = () => sentCodes()[sentCodes().length - 1];
  const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const request = (email = EMAIL) => service.request({ email });
  const verify = (code: string, email = EMAIL) => service.verify({ email, code });
  const complete = (resetToken: string, password = 'new-secret-42') =>
    service.complete({ reset_token: resetToken, password });
  const wrongCode = () => (lastCode() === '000000' ? '000001' : '000000');

  async function rejection(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as ApiException | RetryAfterException;
    }

    throw new Error('expected a rejection');
  }

  async function expectCode(promise: Promise<unknown>, code: string, retryAfterSeconds?: number) {
    const error = await rejection(promise);

    expect(error.getResponse()).toMatchObject({ code });
    if (retryAfterSeconds !== undefined) {
      expect(error).toBeInstanceOf(RetryAfterException);
      expect((error as RetryAfterException).retryAfterSeconds).toBe(retryAfterSeconds);
    }
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
    store = new FakeStore();
    sendResetEmail = jest.fn().mockResolvedValue(undefined);
    service = new PasswordResetService(
      store.challengeRepository as never,
      store.dataSource as never,
      { sendPasswordResetCode: sendResetEmail } as unknown as MailService,
      buildConfigService({ JWT_SECRET }),
    );
  });

  afterEach(async () => {
    await service.settleDeliveries();
    jest.useRealTimers();
  });

  describe('request', () => {
    it('starts a challenge for a verified account and sends its code with the full lifetime', async () => {
      await expect(request()).resolves.toEqual({
        message: PASSWORD_RESET_REQUESTED_MESSAGE,
        resend_after_seconds: 60,
      });
      await service.settleDeliveries();

      expect(sendResetEmail).toHaveBeenCalledWith(
        EMAIL,
        expect.stringMatching(/^\d{6}$/),
        new Date(START.getTime() + 30 * MINUTE),
      );
      expect(store.challenge).toMatchObject({
        email_hash: hashEmail(passwordResetKey(JWT_SECRET), EMAIL),
        user_id: 3,
        attempts: 0,
        started_at: START,
        expires_at: new Date(START.getTime() + 30 * MINUTE),
        window_requests: 1,
        send_attempt_id: 1,
        send_status: ConfirmationCodeSendStatus.SENT,
        last_sent_at: START,
      });
      expect(store.challenge!.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(store.challenge!.code_hash).not.toContain(lastCode());
    });

    it.each([
      ['unknown', null],
      ['unverified', buildUser({ id: 3, email: EMAIL, email_verified: 0 })],
    ])('answers the same for an %s address, sends nothing and keeps the same limits', async (_case, user) => {
      store.user = user;

      await expect(request()).resolves.toEqual({
        message: PASSWORD_RESET_REQUESTED_MESSAGE,
        resend_after_seconds: 60,
      });
      expect(store.challenge).toMatchObject({ user_id: null, code_hash: null, send_status: null, attempts: 0 });
      await expectCode(request(), 'PASSWORD_RESET_RATE_LIMITED', 60);
      expect(sendResetEmail).not.toHaveBeenCalled();
    });

    it('refuses a request within the cooldown without sending or rotating anything', async () => {
      await request();
      const before = { ...store.challenge };
      advance(20_500);

      await expectCode(request(), 'PASSWORD_RESET_RATE_LIMITED', 40);
      expect(store.challenge).toEqual(before);
      expect(sendResetEmail).toHaveBeenCalledTimes(1);
    });

    it('resends a new code that keeps the expiry and the used attempts; only the latest code works', async () => {
      await request();
      const first = lastCode();
      await expectCode(verify(first === '000000' ? '000001' : '000000'), 'PASSWORD_RESET_CODE_INVALID');
      advance(MINUTE);

      await request();

      expect(sendResetEmail).toHaveBeenLastCalledWith(
        EMAIL,
        expect.any(String),
        new Date(START.getTime() + 30 * MINUTE),
      );
      expect(store.challenge).toMatchObject({ attempts: 1, started_at: START, send_attempt_id: 2 });

      if (lastCode() !== first) {
        await expectCode(verify(first), 'PASSWORD_RESET_CODE_INVALID');
      }
      await expect(verify(lastCode())).resolves.toMatchObject({ reset_token: expect.any(String) });
    });

    it('binds a pending challenge to an account verified since it started', async () => {
      store.user = buildUser({ id: 3, email: EMAIL, email_verified: 0 });
      await request();
      store.user = buildUser({ id: 3, email: EMAIL, email_verified: 1 });
      advance(MINUTE);

      await request();

      expect(store.challenge).toMatchObject({ user_id: 3, started_at: START });
      await expect(verify(lastCode())).resolves.toMatchObject({ reset_token: expect.any(String) });
    });

    it('allows 5 accepted requests an hour per address, across challenges', async () => {
      for (let index = 0; index < 5; index++) {
        await request();
        advance(10 * MINUTE);
      }

      await expectCode(request(), 'PASSWORD_RESET_RATE_LIMITED', 600);
      advance(10 * MINUTE);
      await expect(request()).resolves.toBeDefined();
      expect(store.challenge).toMatchObject({
        window_requests: 1,
        window_started_at: new Date(START.getTime() + 60 * MINUTE),
      });
    });

    it('starts a new challenge once the previous one expired', async () => {
      await request();
      advance(30 * MINUTE);

      await request();

      expect(store.challenge).toMatchObject({
        started_at: new Date(START.getTime() + 30 * MINUTE),
        expires_at: new Date(START.getTime() + 60 * MINUTE),
        attempts: 0,
      });
    });

    it('records a failed delivery without telling the client', async () => {
      sendResetEmail.mockRejectedValue(new ServiceUnavailableException());

      await expect(request()).resolves.toMatchObject({ resend_after_seconds: 60 });
      await service.settleDeliveries();

      expect(store.challenge!.send_status).toBe(ConfirmationCodeSendStatus.FAILED);
      expect(store.challenge!.last_sent_at ?? null).toBeNull();
    });

    it('does not let a stale delivery overwrite the outcome of a newer one', async () => {
      let failFirst!: (error: Error) => void;
      sendResetEmail.mockImplementationOnce(() => new Promise((_resolve, reject) => (failFirst = reject)));
      await request();
      advance(MINUTE);
      await request();
      await new Promise(setImmediate);

      expect(store.challenge).toMatchObject({ send_attempt_id: 2, send_status: ConfirmationCodeSendStatus.SENT });

      failFirst(new ServiceUnavailableException());
      await service.settleDeliveries();

      expect(store.challenge!.send_status).toBe(ConfirmationCodeSendStatus.SENT);
      expect(store.challengeRepository.update).toHaveBeenCalledWith(
        { id: '11', send_attempt_id: 1 },
        { send_status: ConfirmationCodeSendStatus.FAILED },
      );
    });

    it('locks the row inserted by a concurrent first request instead of failing', async () => {
      store.insertFailures.push(
        new QueryFailedError('INSERT INTO password_reset_challenges', [], {
          code: 'ER_DUP_ENTRY',
          sqlMessage: "Duplicate entry 'x' for key 'password_reset_challenges.UQ_password_reset_challenges_email_hash'",
        } as unknown as Error),
      );

      await expect(request()).resolves.toBeDefined();
      expect(store.dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(store.challenge).not.toBeNull();
    });

    it('does not retry other insert failures', async () => {
      const failure = new Error('connection lost');
      store.insertFailures.push(failure);

      await expect(request()).rejects.toBe(failure);
      expect(store.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('logs, without throwing, when the delivery outcome cannot be recorded', async () => {
      store.challengeRepository.update.mockRejectedValueOnce(new Error('connection lost'));
      const logError = jest.spyOn(service['logger'], 'error').mockImplementation();

      await request();
      await service.settleDeliveries();

      expect(logError).toHaveBeenCalledWith('Failed to record a password reset email outcome: connection lost');
    });
  });

  describe('address spellings', () => {
    it('sends the code to the stored address for a case variation', async () => {
      await request('USER@Example.COM');
      await service.settleDeliveries();

      expect(sendResetEmail).toHaveBeenCalledWith(EMAIL, expect.any(String), expect.any(Date));
      expect(store.challenge).toMatchObject({ user_id: 3, email_hash: hashEmail(passwordResetKey(JWT_SECRET), EMAIL) });
    });

    it('binds no account to a spelling that differs from the stored one beyond case', async () => {
      await expect(request(ACCENTED)).resolves.toEqual({
        message: PASSWORD_RESET_REQUESTED_MESSAGE,
        resend_after_seconds: 60,
      });
      await service.settleDeliveries();

      expect(sendResetEmail).not.toHaveBeenCalled();
      expect(store.challenge).toMatchObject({ user_id: null, code_hash: null, send_status: null });
    });

    it('accepts no code for a challenge whose address is no longer the account spelling', async () => {
      await request();
      store.user!.email = ACCENTED;

      await expectCode(verify(lastCode()), 'PASSWORD_RESET_CODE_INVALID');
      expect(store.challenge).toMatchObject({ attempts: 1, verified_at: null });
    });

    it('neither replays nor completes such a challenge once it was verified', async () => {
      await request();
      const code = lastCode();
      const { reset_token: token } = await verify(code);
      store.user!.email = ACCENTED;

      await expectCode(verify(code), 'PASSWORD_RESET_CODE_INVALID');
      await expectCode(complete(token), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
      expect(store.user).toMatchObject({ auth_version: 1 });
    });
  });

  describe('verify', () => {
    it('refuses an address that has no challenge', async () => {
      await expectCode(verify('123456'), 'PASSWORD_RESET_CODE_UNUSABLE');
    });

    it('exchanges the code for a reset token valid for 10 minutes, storing only its hash', async () => {
      await request();
      advance(MINUTE);

      const authorization = await verify(lastCode());

      expect(authorization).toEqual({
        reset_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expires_in_seconds: 600,
      });
      expect(store.challenge).toMatchObject({
        verified_at: new Date(START.getTime() + MINUTE),
        reset_token_hash: hashResetToken(authorization.reset_token),
        reset_token_expires_at: new Date(START.getTime() + 11 * MINUTE),
      });
    });

    it('caps the token at the expiry of the code', async () => {
      await request();
      advance(25 * MINUTE);

      await expect(verify(lastCode())).resolves.toMatchObject({ expires_in_seconds: 300 });
    });

    it('returns the same token for a repeat of the accepted code, without extending it', async () => {
      await request();
      const first = await verify(lastCode());
      advance(2 * MINUTE);

      await expect(verify(lastCode())).resolves.toEqual({
        reset_token: first.reset_token,
        expires_in_seconds: 480,
      });
      expect(store.challenge!.reset_token_hash).toBe(hashResetToken(first.reset_token));

      advance(8 * MINUTE);
      await expectCode(verify(lastCode()), 'PASSWORD_RESET_CODE_UNUSABLE');
    });

    it('persists wrong codes and ends the challenge with the fifth', async () => {
      await request();

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expectCode(verify(wrongCode()), 'PASSWORD_RESET_CODE_INVALID');
        expect(store.challenge!.attempts).toBe(attempt);
      }

      await expectCode(verify(wrongCode()), 'PASSWORD_RESET_CODE_UNUSABLE');
      await expectCode(verify(lastCode()), 'PASSWORD_RESET_CODE_UNUSABLE');
      expect(store.challenge).toMatchObject({ attempts: 5, window_failed_attempts: 5 });
    });

    it('counts wrong codes after verification and ends the authorization with the fifth', async () => {
      await request();
      await verify(lastCode());

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expectCode(verify(wrongCode()), 'PASSWORD_RESET_CODE_INVALID');
      }
      await expectCode(verify(wrongCode()), 'PASSWORD_RESET_CODE_UNUSABLE');

      expect(store.challenge).toMatchObject({ reset_token_hash: null, reset_token_expires_at: null });
      await expectCode(verify(lastCode()), 'PASSWORD_RESET_CODE_UNUSABLE');
    });

    it('refuses an expired code without counting it', async () => {
      await request();
      advance(30 * MINUTE);

      await expectCode(verify(lastCode()), 'PASSWORD_RESET_CODE_UNUSABLE');
      expect(store.challenge).toMatchObject({ attempts: 0, window_failed_attempts: 0 });
    });

    it.each([
      ['unknown', null],
      ['unverified', buildUser({ id: 3, email: EMAIL, email_verified: 0 })],
    ])('treats every code for an %s address as wrong, with the same limits', async (_case, user) => {
      store.user = user;
      await request();

      for (let attempt = 1; attempt <= 4; attempt++) {
        await expectCode(verify('123456'), 'PASSWORD_RESET_CODE_INVALID');
      }
      await expectCode(verify('123456'), 'PASSWORD_RESET_CODE_UNUSABLE');
    });

    it('allows 10 wrong codes an hour across challenges, then refuses even the right one', async () => {
      await request();
      for (let attempt = 0; attempt < 5; attempt++) {
        await rejection(verify(wrongCode()));
      }
      advance(MINUTE);
      await request();
      for (let attempt = 0; attempt < 5; attempt++) {
        await rejection(verify(wrongCode()));
      }
      advance(MINUTE);
      await request();

      await expectCode(verify(lastCode()), 'PASSWORD_RESET_RATE_LIMITED', 58 * 60);
      advance(58 * MINUTE);
      await request();
      await expect(verify(lastCode())).resolves.toMatchObject({ reset_token: expect.any(String) });
    });

    it('lets a new request replace an issued authorization', async () => {
      await request();
      await verify(lastCode());
      advance(MINUTE);

      await request();

      expect(store.challenge).toMatchObject({
        verified_at: null,
        reset_token_hash: null,
        attempts: 0,
        started_at: new Date(START.getTime() + MINUTE),
      });
    });
  });

  describe('complete', () => {
    async function authorize() {
      await request();
      return (await verify(lastCode())).reset_token;
    }

    it('changes the password, bumps the auth version and consumes the challenge', async () => {
      const token = await authorize();
      advance(MINUTE);
      const locks = jest.spyOn(store.manager, 'createQueryBuilder');

      await expect(complete(token)).resolves.toBeUndefined();

      expect(locks.mock.calls.map(([entity]) => entity)).toEqual([User, PasswordResetChallenge]);
      expect(store.user).toMatchObject({ password: 'bcrypt(new-secret-42)', auth_version: 2 });
      expect(store.challenge).toMatchObject({
        completed_at: new Date(START.getTime() + MINUTE),
        code_hash: null,
        reset_token_hash: null,
      });
    });

    it('never accepts the same authorization twice', async () => {
      const token = await authorize();
      await complete(token);

      await expectCode(complete(token, 'other-secret-7'), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
      expect(store.user).toMatchObject({ password: 'bcrypt(new-secret-42)', auth_version: 2 });
    });

    it('ends the challenge, so the accepted code no longer yields a token', async () => {
      await request();
      const code = lastCode();
      await complete((await verify(code)).reset_token);

      await expectCode(verify(code), 'PASSWORD_RESET_CODE_UNUSABLE');
    });

    it('refuses an unknown token without opening a transaction', async () => {
      await authorize();

      await expectCode(complete('not-a-token'), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
      expect(store.dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(store.user).toMatchObject({ auth_version: 1 });
    });

    it('refuses an expired token', async () => {
      const token = await authorize();
      advance(10 * MINUTE);

      await expectCode(complete(token), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
      expect(store.user).toMatchObject({ auth_version: 1 });
    });

    it('refuses a token whose challenge was ended by the fifth wrong code', async () => {
      const token = await authorize();
      for (let attempt = 0; attempt < 5; attempt++) {
        await rejection(verify(wrongCode()));
      }

      await expectCode(complete(token), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
    });

    it('checks the token again under the locks', async () => {
      const token = await authorize();
      const stale = { ...store.challenge! };
      advance(MINUTE);
      await request();
      store.challengeRepository.findOne.mockResolvedValueOnce(stale);

      await expectCode(complete(token), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
      expect(store.user).toMatchObject({ auth_version: 1 });
    });

    it('refuses when the account was deleted after the check', async () => {
      const token = await authorize();
      store.user = null;

      await expectCode(complete(token), 'PASSWORD_RESET_AUTHORIZATION_INVALID');
    });
  });
});
