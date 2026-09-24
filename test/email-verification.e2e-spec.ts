import request from 'supertest';
import { ObjectLiteral, Repository } from 'typeorm';

import { Category } from '@entities/category.entity';
import { User } from '@entities/user.entity';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { UsersService } from '@modules/users/users.service';
import { ConfirmationType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { DEFAULT_CATEGORIES, MAX_CONFIRMATION_CODE_ATTEMPTS } from '@shared/constants';
import { createTestApp, deleteUsers, PASSWORD, TestApp, uniqueEmail } from './support/app';
import { LOCK_USER, overlap, pauseAfterFirstCall } from './support/concurrency';

const STARTER_CATEGORIES = DEFAULT_CATEGORIES.length + 1;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

describe('Email verification (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(() => {
    testApp.resetThrottling();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  async function registerWithCode(): Promise<{ userId: number; email: string; code: string }> {
    const email = uniqueEmail('verify');
    const user = await testApp.app
      .get(UsersService)
      .register({ name: 'Verify', email, password: PASSWORD, base_currency_id: testApp.currencyId });
    userIds.push(user.id);
    const { code } = await testApp.app.get(ConfirmationCodesService).reserveSend(user.id, ConfirmationType.EMAIL);

    return { userId: user.id, email, code };
  }

  function verify(email: string, code: string) {
    return request(testApp.app.getHttpServer()).post('/api/v1/users/verify-email').send({ email, code });
  }

  async function starterData(userId: number): Promise<{ verified: number; wallets: number; categories: number }> {
    const [user] = await testApp.dataSource.query('SELECT email_verified FROM users WHERE id = ?', [userId]);
    const [{ wallets }] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS wallets FROM wallets w INNER JOIN space_members m ON m.space_id = w.space_id WHERE m.user_id = ?',
      [userId],
    );
    const [{ categories }] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS categories FROM categories c INNER JOIN space_members m ON m.space_id = c.space_id WHERE m.user_id = ?',
      [userId],
    );

    return { verified: user.email_verified, wallets: Number(wallets), categories: Number(categories) };
  }

  async function activeCode(userId: number): Promise<{ attempts: number } | undefined> {
    const [row] = await testApp.dataSource.query(
      'SELECT attempts FROM confirmation_codes WHERE user_id = ? AND expired_at >= ?',
      [userId, new Date()],
    );
    return row;
  }

  const NOTHING_CREATED = { verified: 0, wallets: 0, categories: 0 };
  const ONE_STARTER_SET = { verified: 1, wallets: 1, categories: STARTER_CATEGORIES };

  it('lets only the first of two overlapping confirmations through, with one set of starter data', async () => {
    const { userId, email, code } = await registerWithCode();
    const checkpoint = pauseAfterFirstCall(testApp.app.get(ConfirmationCodesService), 'lockActive');

    const [first, second] = await overlap(
      testApp.dataSource,
      checkpoint,
      LOCK_USER,
      () => verify(email, code),
      () => verify(email, code),
    );

    expect(first.status).toBe(201);
    expect(first.text).toMatch(JWT);
    expect(second.status).toBe(409);
    expect(second.body.message).toBe(ErrorMessages.EMAIL_ALREADY_VERIFIED);
    expect(second.text).not.toContain(first.text);
    expect(await starterData(userId)).toEqual(ONE_STARTER_SET);
    expect(await activeCode(userId)).toBeUndefined();
  });

  it('refuses to reuse a code that was already redeemed', async () => {
    const { userId, email, code } = await registerWithCode();

    const first = await verify(email, code);
    const reuse = await verify(email, code);

    expect(first.status).toBe(201);
    expect(reuse.status).toBe(409);
    expect(reuse.body.message).toBe(ErrorMessages.EMAIL_ALREADY_VERIFIED);
    expect(reuse.text).not.toMatch(JWT);
    expect(await starterData(userId)).toEqual(ONE_STARTER_SET);
  });

  it('keeps every wrong attempt and still accepts the right code afterwards', async () => {
    const { userId, email, code } = await registerWithCode();
    const wrong = code === '000000' ? '111111' : '000000';

    const firstWrong = await verify(email, wrong);
    const secondWrong = await verify(email, wrong);

    expect([firstWrong.status, secondWrong.status]).toEqual([400, 400]);
    expect(secondWrong.body.message).toBe(ErrorMessages.INVALID_CREDENTIALS);
    expect(await activeCode(userId)).toEqual({ attempts: 2 });
    expect(await starterData(userId)).toEqual(NOTHING_CREATED);

    const right = await verify(email, code);

    expect(right.status).toBe(201);
    expect(await starterData(userId)).toEqual(ONE_STARTER_SET);
  });

  it('keeps the code expired once the attempt limit is reached', async () => {
    const { userId, email, code } = await registerWithCode();
    await testApp.dataSource.query('UPDATE confirmation_codes SET attempts = ? WHERE user_id = ?', [
      MAX_CONFIRMATION_CODE_ATTEMPTS,
      userId,
    ]);

    const limited = await verify(email, code);
    const afterwards = await verify(email, code);

    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe(ErrorMessages.TOO_MANY_ATTEMPTS);
    expect(afterwards.status).toBe(404);
    expect(await activeCode(userId)).toBeUndefined();
    expect(await starterData(userId)).toEqual(NOTHING_CREATED);
  });

  it('rolls everything back when initialization fails, so the same code can be retried', async () => {
    const { userId, email, code } = await registerWithCode();
    const originalSave = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function (
      this: Repository<ObjectLiteral>,
      ...args: Parameters<typeof originalSave>
    ) {
      if (this.target === Category) {
        return Promise.reject(new Error('injected initialization failure'));
      }
      return Reflect.apply(originalSave, this, args);
    });

    const failed = await verify(email, code);

    expect(failed.status).toBe(500);
    expect(failed.text).not.toMatch(JWT);
    expect(await starterData(userId)).toEqual(NOTHING_CREATED);
    expect(await activeCode(userId)).toEqual({ attempts: 0 });

    jest.restoreAllMocks();
    const retried = await verify(email, code);

    expect(retried.status).toBe(201);
    expect(retried.text).toMatch(JWT);
    expect(await starterData(userId)).toEqual(ONE_STARTER_SET);
  });

  it('creates one set of starter data when the internal initialization overlaps itself', async () => {
    const { userId } = await registerWithCode();
    const usersService = testApp.app.get(UsersService);
    const checkpoint = pauseAfterFirstCall(Repository.prototype, 'update', (self) => {
      return (self as Repository<ObjectLiteral>).target === User;
    });

    await overlap(
      testApp.dataSource,
      checkpoint,
      LOCK_USER,
      () => usersService.completeEmailVerification(userId),
      () => usersService.completeEmailVerification(userId),
    );

    expect(await starterData(userId)).toEqual(ONE_STARTER_SET);
  });
});
