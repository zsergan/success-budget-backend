import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';

import { UsersService } from './users.service';
import { User } from '../../entities/user.entity';
import { Wallet } from '../../entities/wallet.entity';
import { Category } from '../../entities/category.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType } from '../../shared/enums';

const JWT_SECRET_FOR_TESTS = 'test-secret';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
  hashSync: jest.fn().mockReturnValue('dummy-password-hash'),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bcrypt = require('bcrypt') as { compare: jest.Mock; hash: jest.Mock; hashSync: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<Repository<User>>;
  let userRepositoryInTx: { update: jest.Mock };
  let confirmationCodeRepositoryInTx: { update: jest.Mock };
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let categoryRepositoryInTx: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let confirmationCodesService: jest.Mocked<ConfirmationCodesService>;

  beforeEach(async () => {
    const queryBuilder = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    userRepositoryInTx = { update: jest.fn() };
    confirmationCodeRepositoryInTx = { update: jest.fn() };
    walletRepositoryInTx = { create: jest.fn(), save: jest.fn() };
    categoryRepositoryInTx = { save: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === User) return userRepositoryInTx;
        if (entity === ConfirmationCode) return confirmationCodeRepositoryInTx;
        if (entity === Wallet) return walletRepositoryInTx;
        if (entity === Category) return categoryRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            findOne: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue(JWT_SECRET_FOR_TESTS) } },
        {
          provide: ConfirmationCodesService,
          useValue: { getOne: jest.fn(), expire: jest.fn(), incrementAttempts: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    repository = module.get(getRepositoryToken(User));
    confirmationCodesService = module.get(ConfirmationCodesService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it('creates and persists a new user', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const created = { ...dto } as User;
      const saved = { ...dto, id: 1 } as User;

      repository.create.mockReturnValue(created);
      repository.save.mockResolvedValue(saved);

      const result = await service.register(dto);

      expect(repository.create).toHaveBeenCalledWith(dto);
      expect(repository.save).toHaveBeenCalledWith(created);
      expect(result).toEqual(saved);
    });
  });

  describe('updateUnverified', () => {
    it('re-hashes the new password and updates name/currency, then returns the refreshed user', async () => {
      const dto = { email: 'a@b.com', name: 'New Name', password: 'newpw', base_currency_id: 2 } as any;
      const refreshed = { id: 4, name: 'New Name' } as User;
      bcrypt.hash.mockResolvedValue('hashed-newpw');
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue(refreshed);

      const result = await service.updateUnverified(4, dto);

      expect(bcrypt.hash).toHaveBeenCalledWith('newpw', 10);
      expect(repository.update).toHaveBeenCalledWith(4, {
        name: 'New Name',
        password: 'hashed-newpw',
        base_currency_id: 2,
      });
      expect(result).toBe(refreshed);
    });
  });

  describe('verify', () => {
    it('marks the user verified and returns a fresh access token', async () => {
      const user = { id: 7, email: 'a@b.com' } as User;
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue(user);

      const token = await service.verify(7);

      expect(repository.update).toHaveBeenCalledWith(7, { email_verified: 1 });
      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number };
      expect(decoded.id).toBe(7);
    });
  });

  describe('registerOrRefresh', () => {
    it('rejects when the email already belongs to a verified user', async () => {
      repository.findOne.mockResolvedValue({ id: 1, email_verified: 1 } as User);

      await expect(service.registerOrRefresh({ email: 'a@b.com' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
      );
    });

    it('creates a new user when none exists yet', async () => {
      repository.findOne.mockResolvedValue(null);
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const created = { ...dto } as User;
      repository.create.mockReturnValue(created);
      repository.save.mockResolvedValue({ ...created, id: 2 } as User);

      const result = await service.registerOrRefresh(dto);

      expect(repository.save).toHaveBeenCalledWith(created);
      expect(result).toMatchObject({ id: 2 });
    });

    it('refreshes an existing unverified user instead of creating a duplicate', async () => {
      const existing = { id: 3, email: 'a@b.com', email_verified: 0 } as User;
      repository.findOne.mockResolvedValue(existing);
      bcrypt.hash.mockResolvedValue('hashed');
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue({ id: 3, name: 'New' } as User);

      const dto = { email: 'a@b.com', name: 'New', password: 'newpw', base_currency_id: 1 } as any;
      const result = await service.registerOrRefresh(dto);

      expect(repository.update).toHaveBeenCalledWith(3, expect.objectContaining({ name: 'New' }));
      expect(result).toMatchObject({ id: 3, name: 'New' });
    });
  });

  describe('completeEmailVerification', () => {
    it('marks the user verified, expires the code, provisions defaults, and returns a token in one transaction', async () => {
      const user = { id: 1, base_currency_id: 5 } as User;
      walletRepositoryInTx.create.mockReturnValue({ id: 10 });

      const token = await service.completeEmailVerification(user, 7);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(userRepositoryInTx.update).toHaveBeenCalledWith(1, { email_verified: 1 });
      expect(confirmationCodeRepositoryInTx.update).toHaveBeenCalledWith(7, { expired_at: expect.any(Date) });
      expect(walletRepositoryInTx.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, wallet_name: 'Cash', currency_id: 5 }),
      );
      expect(walletRepositoryInTx.save).toHaveBeenCalledWith({ id: 10 });
      expect(categoryRepositoryInTx.save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ user_id: 1 })]),
      );
      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number };
      expect(decoded.id).toBe(1);
    });

    it('propagates a failure from inside the transaction instead of returning a token', async () => {
      const user = { id: 1, base_currency_id: 5 } as User;
      walletRepositoryInTx.save.mockRejectedValue(new Error('db unavailable'));

      await expect(service.completeEmailVerification(user, 7)).rejects.toThrow('db unavailable');
    });
  });

  describe('verifyEmail', () => {
    it('rejects when the user does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
    });

    it('rejects when there is no active confirmation code', async () => {
      repository.findOne.mockResolvedValue({ id: 1 } as User);
      confirmationCodesService.getOne.mockResolvedValue(null);

      await expect(service.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
    });

    it('rejects when the code does not match and records the failed attempt', async () => {
      repository.findOne.mockResolvedValue({ id: 1 } as User);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '9999', attempts: 0 } as any);

      await expect(service.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400),
      );
      expect(confirmationCodesService.incrementAttempts).toHaveBeenCalledWith(7);
    });

    it('rejects and expires the code once the attempt limit is reached', async () => {
      repository.findOne.mockResolvedValue({ id: 1 } as User);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '9999', attempts: 5 } as any);

      await expect(service.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, 429),
      );
      expect(confirmationCodesService.expire).toHaveBeenCalledWith(1, ConfirmationType.EMAIL);
      expect(confirmationCodesService.incrementAttempts).not.toHaveBeenCalled();
    });

    it('completes email verification on a matching code', async () => {
      const user = { id: 1, base_currency_id: 5 } as User;
      repository.findOne.mockResolvedValue(user);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '1234' } as any);
      walletRepositoryInTx.create.mockReturnValue({ id: 10 });

      const token = await service.verifyEmail({ email: 'x@x.com', code: '1234' } as any);

      expect(userRepositoryInTx.update).toHaveBeenCalledWith(1, { email_verified: 1 });
      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number };
      expect(decoded.id).toBe(1);
    });
  });

  describe('login', () => {
    it('rejects when no user matches the email', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.login({ email: 'missing@x.com', password: 'pw' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );
    });

    it('still runs a bcrypt comparison when no user matches, to avoid a timing side-channel', async () => {
      repository.findOne.mockResolvedValue(null);
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login({ email: 'missing@x.com', password: 'pw' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );

      expect(bcrypt.compare).toHaveBeenCalledWith('pw', 'dummy-password-hash');
    });

    it('rejects when the password does not match', async () => {
      repository.findOne.mockResolvedValue({ id: 1, password: 'hashed' } as User);
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login({ email: 'a@b.com', password: 'wrong' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );
    });

    it('rejects when the email is not verified yet', async () => {
      repository.findOne.mockResolvedValue({ id: 3, password: 'hashed', email_verified: 0 } as User);
      bcrypt.compare.mockResolvedValue(true);

      await expect(service.login({ email: 'a@b.com', password: 'right' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_NOT_VERIFIED, 403),
      );
    });

    it('returns an access token on valid credentials for a verified user', async () => {
      repository.findOne.mockResolvedValue({ id: 3, password: 'hashed', email_verified: 1 } as User);
      bcrypt.compare.mockResolvedValue(true);

      const token = await service.login({ email: 'a@b.com', password: 'right' } as any);

      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number };
      expect(decoded.id).toBe(3);
    });

    it('sets a ~90 day expiry, not 90000 days', async () => {
      repository.findOne.mockResolvedValue({ id: 3, password: 'hashed', email_verified: 1 } as User);
      bcrypt.compare.mockResolvedValue(true);

      const token = await service.login({ email: 'a@b.com', password: 'right' } as any);

      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number; exp: number; iat: number };
      const ninetyDaysInSeconds = 60 * 60 * 24 * 90;
      expect(decoded.exp - decoded.iat).toBe(ninetyDaysInSeconds);
    });
  });

  describe('findByEmail', () => {
    it('looks up the user by email', async () => {
      const user = { id: 1, email: 'a@b.com' } as User;
      repository.findOne.mockResolvedValue(user);

      const result = await service.findByEmail('a@b.com');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
      expect(result).toEqual(user);
    });
  });
});
