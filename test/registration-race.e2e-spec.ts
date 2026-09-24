import { HttpException, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';

import { User } from '@entities/user.entity';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { UsersService } from '@modules/users/users.service';
import { ConfirmationType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import type { CreateUserDto } from '@modules/users/dto/create-user.dto';

const PARALLEL = 5;
const PASSWORD = 'DevTest#2026';

describe('Registration races (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let usersService: UsersService;
  let confirmationCodesService: ConfirmationCodesService;
  let currencyIds: number[];
  const emails: string[] = [];

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

    const currencies: { id: number }[] = await dataSource.query('SELECT id FROM currencies ORDER BY id LIMIT 2');
    currencyIds = currencies.map((currency) => currency.id);
  });

  afterAll(async () => {
    try {
      if (emails.length) {
        const users: { id: number }[] = await dataSource.query('SELECT id FROM users WHERE email IN (?)', [emails]);
        const userIds = users.map((user) => user.id);
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
      }
    } finally {
      await app.close();
    }
  });

  function newEmail(): string {
    const email = `e2e-registration-race-${Date.now()}-${Math.random()}@example.com`;
    emails.push(email);
    return email;
  }

  function registration(email: string, overrides: Partial<CreateUserDto> = {}): CreateUserDto {
    return { name: 'Original', email, password: PASSWORD, base_currency_id: currencyIds[0], ...overrides };
  }

  async function accounts(email: string): Promise<{ users: number; spaces: number }> {
    const [{ users }] = await dataSource.query('SELECT COUNT(*) AS users FROM users WHERE email = ?', [email]);
    const [{ spaces }] = await dataSource.query(
      'SELECT COUNT(*) AS spaces FROM space_members m INNER JOIN users u ON u.id = m.user_id WHERE u.email = ?',
      [email],
    );

    return { users: Number(users), spaces: Number(spaces) };
  }

  async function verifiedAccount(): Promise<User> {
    const email = newEmail();
    const user = await usersService.register(registration(email));
    await usersService.completeEmailVerification(user.id);

    return user;
  }

  async function expectUnchanged(user: User): Promise<void> {
    const [row] = await dataSource.query(
      'SELECT u.name, s.currency_id FROM users u INNER JOIN space_members m ON m.user_id = u.id INNER JOIN spaces s ON s.id = m.space_id WHERE u.id = ?',
      [user.id],
    );
    expect(row).toEqual({ name: 'Original', currency_id: currencyIds[0] });
    await expect(usersService.login({ email: user.email, password: PASSWORD })).resolves.toEqual(expect.any(String));
  }

  it('creates one user and one personal space for concurrent first registrations', async () => {
    const email = newEmail();

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, (_, index) =>
        usersService.registerOrRefresh(registration(email, { name: `Racer ${index}` })),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(Array(PARALLEL).fill('fulfilled'));
    const ids = new Set(results.map((result) => (result as PromiseFulfilledResult<User>).value.id));
    expect(ids.size).toBe(1);
    expect(await accounts(email)).toEqual({ users: 1, spaces: 1 });
  });

  it('treats an email differing only in case as the same account', async () => {
    const email = newEmail();
    await usersService.registerOrRefresh(registration(email));

    await usersService.registerOrRefresh(registration(email.toUpperCase(), { name: 'Shouting' }));

    expect(await accounts(email)).toEqual({ users: 1, spaces: 1 });
  });

  it('does not change a verified account on re-registration', async () => {
    const user = await verifiedAccount();

    await expect(
      usersService.registerOrRefresh(
        registration(user.email, { name: 'Takeover', password: 'Other#2026', base_currency_id: currencyIds[1] }),
      ),
    ).rejects.toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));

    await expectUnchanged(user);
  });

  it('does not change an account verified after the caller checked it', async () => {
    const user = await verifiedAccount();

    await expect(
      usersService.updateUnverified(
        user.id,
        registration(user.email, { name: 'Takeover', password: 'Other#2026', base_currency_id: currencyIds[1] }),
      ),
    ).rejects.toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));

    await expectUnchanged(user);
  });

  it('does not reserve an email code for an account verified after the caller checked it', async () => {
    const user = await verifiedAccount();

    await expect(confirmationCodesService.reserveSend(user.id, ConfirmationType.EMAIL)).rejects.toMatchObject(
      new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
    );

    const codes = await dataSource.query('SELECT id FROM confirmation_codes WHERE user_id = ?', [user.id]);
    expect(codes).toEqual([]);
  });

  it('never lets a re-registration racing the verification change the verified account', async () => {
    for (let round = 0; round < PARALLEL; round++) {
      const email = newEmail();
      const user = await usersService.register(registration(email));
      const { code } = await confirmationCodesService.reserveSend(user.id, ConfirmationType.EMAIL);

      const [verification, reRegistration] = await Promise.allSettled([
        usersService.verifyEmail({ email, code }),
        usersService.registerOrRefresh(registration(email, { name: 'Late' })),
      ]);

      expect(verification.status).toBe('fulfilled');
      if (reRegistration.status === 'rejected') {
        expect(reRegistration.reason).toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));
        const [row] = await dataSource.query('SELECT name FROM users WHERE id = ?', [user.id]);
        expect(row.name).toBe('Original');
      }
      expect(await accounts(email)).toEqual({ users: 1, spaces: 1 });
    }
  });
});
