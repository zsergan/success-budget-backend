import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

import { Category } from '@entities/category.entity';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { UsersService } from '@modules/users/users.service';
import { ConfirmationType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { DEFAULT_CATEGORIES, MAX_CONFIRMATION_CODE_ATTEMPTS } from '@shared/constants';

const PARALLEL = 5;
const STARTER_CATEGORIES = DEFAULT_CATEGORIES.length + 1;

describe('Email verification (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let usersService: UsersService;
  let confirmationCodesService: ConfirmationCodesService;
  let currencyId: number;
  const userIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usersService = moduleFixture.get(UsersService);
    confirmationCodesService = moduleFixture.get(ConfirmationCodesService);

    const [currency] = await dataSource.query('SELECT id FROM currencies LIMIT 1');
    currencyId = currency.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (userIds.length) {
        const members: { space_id: number }[] = await dataSource.query(
          'SELECT space_id FROM space_members WHERE user_id IN (?)',
          [userIds],
        );
        const spaceIds = members.map((member) => member.space_id);
        if (spaceIds.length) {
          await dataSource.query('DELETE FROM wallets WHERE space_id IN (?)', [spaceIds]);
          await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
        }
        await dataSource.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
    } finally {
      await app.close();
    }
  });

  async function registerWithCode(): Promise<{ userId: number; email: string; code: string }> {
    const email = `e2e-verify-${Date.now()}-${Math.random()}@example.com`;
    const user = await usersService.register({
      name: 'Verify',
      email,
      password: 'DevTest#2026',
      base_currency_id: currencyId,
    });
    userIds.push(user.id);
    const reservation = await confirmationCodesService.reserveSend(user.id, ConfirmationType.EMAIL);

    return { userId: user.id, email, code: reservation.code };
  }

  async function starterData(userId: number): Promise<{ verified: number; wallets: number; categories: number }> {
    const [user] = await dataSource.query('SELECT email_verified FROM users WHERE id = ?', [userId]);
    const [{ wallets }] = await dataSource.query(
      'SELECT COUNT(*) AS wallets FROM wallets w INNER JOIN space_members m ON m.space_id = w.space_id WHERE m.user_id = ?',
      [userId],
    );
    const [{ categories }] = await dataSource.query(
      'SELECT COUNT(*) AS categories FROM categories c INNER JOIN space_members m ON m.space_id = c.space_id WHERE m.user_id = ?',
      [userId],
    );

    return { verified: user.email_verified, wallets: Number(wallets), categories: Number(categories) };
  }

  async function activeCode(userId: number): Promise<{ attempts: number } | undefined> {
    const [row] = await dataSource.query(
      'SELECT attempts FROM confirmation_codes WHERE user_id = ? AND expired_at >= ?',
      [userId, new Date()],
    );

    return row;
  }

  function failSavesOf(entity: typeof Category): void {
    const originalSave = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function (
      this: Repository<ObjectLiteral>,
      ...args: Parameters<typeof originalSave>
    ) {
      if (this.target === entity) {
        return Promise.reject(new Error('injected failure'));
      }
      return Reflect.apply(originalSave, this, args);
    });
  }

  it('lets exactly one of several parallel confirmations through and creates one set of starter data', async () => {
    const { userId, email, code } = await registerWithCode();

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, () => usersService.verifyEmail({ email, code })),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    for (const result of rejected) {
      expect(result.reason).toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_VERIFIED, 409));
    }
    expect(await starterData(userId)).toEqual({ verified: 1, wallets: 1, categories: STARTER_CATEGORIES });
    expect(await activeCode(userId)).toBeUndefined();
  });

  it('answers a confirmation with an already used code with a controlled error and no token', async () => {
    const { email, code } = await registerWithCode();
    const verify = () => request(app.getHttpServer()).post('/api/v1/users/verify-email').send({ email, code });

    const first = await verify();
    const second = await verify();

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ message: ErrorMessages.EMAIL_ALREADY_VERIFIED });
    expect(second.text).not.toContain(first.text);
  });

  it('keeps the failed attempt when a wrong code is rejected', async () => {
    const { userId, email, code } = await registerWithCode();

    await expect(
      usersService.verifyEmail({ email, code: code === '000000' ? '111111' : '000000' }),
    ).rejects.toMatchObject(new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400));

    expect(await activeCode(userId)).toEqual({ attempts: 1 });
    expect(await starterData(userId)).toEqual({ verified: 0, wallets: 0, categories: 0 });
  });

  it('keeps the expiry when the attempt limit is reached', async () => {
    const { userId, email, code } = await registerWithCode();
    await dataSource.query('UPDATE confirmation_codes SET attempts = ? WHERE user_id = ?', [
      MAX_CONFIRMATION_CODE_ATTEMPTS,
      userId,
    ]);

    await expect(usersService.verifyEmail({ email, code })).rejects.toMatchObject(
      new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, 429),
    );

    expect(await activeCode(userId)).toBeUndefined();
    expect(await starterData(userId)).toEqual({ verified: 0, wallets: 0, categories: 0 });
  });

  it('rolls everything back when initialization fails, so the same code can be retried', async () => {
    const { userId, email, code } = await registerWithCode();
    failSavesOf(Category);

    await expect(usersService.verifyEmail({ email, code })).rejects.toThrow('injected failure');

    jest.restoreAllMocks();
    expect(await starterData(userId)).toEqual({ verified: 0, wallets: 0, categories: 0 });
    expect(await activeCode(userId)).toEqual({ attempts: 0 });

    await expect(usersService.verifyEmail({ email, code })).resolves.toEqual(expect.any(String));
    expect(await starterData(userId)).toEqual({ verified: 1, wallets: 1, categories: STARTER_CATEGORIES });
  });

  it('creates one set of starter data when the internal initialization runs in parallel', async () => {
    const { userId } = await registerWithCode();

    await Promise.all(Array.from({ length: PARALLEL }, () => usersService.completeEmailVerification(userId)));

    expect(await starterData(userId)).toEqual({ verified: 1, wallets: 1, categories: STARTER_CATEGORIES });
  });
});
