import * as bcrypt from 'bcrypt';
import { QueryFailedError, type DataSource } from 'typeorm';

import { provisionTestFlightAccount, readTestFlightInput } from './testflight-account';
import { User } from '@entities/user.entity';
import { Currency } from '@entities/currency.entity';

const EMAIL = 'demo@example.com';
const PASSWORD = 'Demo-pass-2026';

const queryError = (code: string, sqlMessage: string) =>
  new QueryFailedError('SQL', [], Object.assign(new Error(sqlMessage), { code, sqlMessage }));

describe('readTestFlightInput', () => {
  const read = (email?: string, password?: string) =>
    readTestFlightInput({ TESTFLIGHT_USER_EMAIL: email, TESTFLIGHT_USER_PASSWORD: password });

  it('returns the email and password', () => {
    expect(read(EMAIL, PASSWORD)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it.each([
    ['a missing email', undefined, PASSWORD, 'TESTFLIGHT_USER_EMAIL should not be empty'],
    ['an invalid email', 'not-an-email', PASSWORD, 'TESTFLIGHT_USER_EMAIL must be an email'],
    ['a missing password', EMAIL, undefined, 'TESTFLIGHT_USER_PASSWORD must be a string'],
    ['a short password', EMAIL, 'abc12', 'TESTFLIGHT_USER_PASSWORD must be longer than or equal to 8 characters'],
    ['a password without a digit', EMAIL, 'password-only', 'TESTFLIGHT_USER_PASSWORD must contain a digit'],
    ['a password without a letter', EMAIL, '1234-5678', 'TESTFLIGHT_USER_PASSWORD must contain a letter'],
    ['a password over 72 bytes', EMAIL, `a1${'я'.repeat(36)}`, 'TESTFLIGHT_USER_PASSWORD must be at most 72 bytes'],
  ])('rejects %s', (_case, email, password, problem) => {
    expect(() => read(email, password)).toThrow(problem);
  });

  it('never repeats the password in its error', () => {
    const password = 'no-digits-here-secret';

    expect(() => read(EMAIL, password)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(password) }),
    );
  });
});

describe('provisionTestFlightAccount', () => {
  let userRepository: { findOneBy: jest.Mock; findOneByOrFail: jest.Mock };
  let currencyRepository: { findOneBy: jest.Mock };
  let transaction: jest.Mock;
  let dataSource: DataSource;

  const account = async (overrides: Partial<User> = {}) =>
    ({ id: 1, email: EMAIL, password: await bcrypt.hash(PASSWORD, 4), email_verified: 1, ...overrides }) as User;

  beforeEach(() => {
    userRepository = { findOneBy: jest.fn().mockResolvedValue(null), findOneByOrFail: jest.fn() };
    currencyRepository = { findOneBy: jest.fn().mockResolvedValue(null) };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Currency) return currencyRepository;
        throw new Error(`unexpected write to ${String(entity)}`);
      }),
    };
    transaction = jest.fn((_isolation, work) => work(manager));
    dataSource = {
      getRepository: jest.fn((entity) => {
        if (entity === User) return userRepository;
        throw new Error(`unexpected repository ${String(entity)}`);
      }),
      transaction,
    } as unknown as DataSource;
  });

  it('accepts an existing verified account with this password without opening a transaction', async () => {
    userRepository.findOneBy.mockResolvedValue(await account());

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).resolves.toBe(
      'existing',
    );
    expect(userRepository.findOneBy).toHaveBeenCalledWith({ email: EMAIL });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses an existing account that does not accept the password', async () => {
    userRepository.findOneBy.mockResolvedValue(await account());

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: 'Other-pass-2026' })).rejects.toThrow(
      'does not accept this password. Nothing was changed.',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses an existing unverified account', async () => {
    userRepository.findOneBy.mockResolvedValue(await account({ email_verified: 0 }));

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).rejects.toThrow(
      'its email is not verified. Nothing was changed.',
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails before any write when USD is missing', async () => {
    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).rejects.toThrow(
      'Currency USD is missing',
    );
    expect(currencyRepository.findOneBy).toHaveBeenCalledWith({ code: 'USD' });
  });

  it('checks the account a concurrent run created first', async () => {
    transaction.mockRejectedValue(queryError('ER_DUP_ENTRY', "Duplicate entry for key 'users.UQ_users_email'"));
    userRepository.findOneByOrFail.mockResolvedValue(await account());

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).resolves.toBe(
      'existing',
    );
    expect(userRepository.findOneByOrFail).toHaveBeenCalledWith({ email: EMAIL });
  });

  it('refuses the account a concurrent run created with another password', async () => {
    transaction.mockRejectedValue(queryError('ER_DUP_ENTRY', "Duplicate entry for key 'users.UQ_users_email'"));
    userRepository.findOneByOrFail.mockResolvedValue({ ...(await account()), password: await bcrypt.hash('x1', 4) });

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).rejects.toThrow(
      'does not accept this password',
    );
  });

  it('rethrows any other failure', async () => {
    transaction.mockRejectedValue(queryError('ER_NO_REFERENCED_ROW_2', 'foreign key'));

    await expect(provisionTestFlightAccount(dataSource, { email: EMAIL, password: PASSWORD })).rejects.toThrow(
      'foreign key',
    );
    expect(userRepository.findOneByOrFail).not.toHaveBeenCalled();
  });
});
