import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';

import { UsersService } from './users.service';
import { User } from '../../entities/user.entity';
import { Wallet } from '../../entities/wallet.entity';
import { Category } from '../../entities/category.entity';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { ErrorMessages } from '../../shared/error-messages';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bcrypt = require('bcrypt') as { compare: jest.Mock; hash: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<Repository<User>>;
  let userRepositoryInTx: { update: jest.Mock };
  let confirmationCodeRepositoryInTx: { update: jest.Mock };
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let categoryRepositoryInTx: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

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
      ],
    }).compile();

    service = module.get(UsersService);
    repository = module.get(getRepositoryToken(User));
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
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: number };
      expect(decoded.id).toBe(7);
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
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: number };
      expect(decoded.id).toBe(1);
    });

    it('propagates a failure from inside the transaction instead of returning a token', async () => {
      const user = { id: 1, base_currency_id: 5 } as User;
      walletRepositoryInTx.save.mockRejectedValue(new Error('db unavailable'));

      await expect(service.completeEmailVerification(user, 7)).rejects.toThrow('db unavailable');
    });
  });

  describe('login', () => {
    it('rejects when no user matches the email', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.login({ email: 'missing@x.com', password: 'pw' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );
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

      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: number };
      expect(decoded.id).toBe(3);
    });

    it('sets a ~90 day expiry, not 90000 days', async () => {
      repository.findOne.mockResolvedValue({ id: 3, password: 'hashed', email_verified: 1 } as User);
      bcrypt.compare.mockResolvedValue(true);

      const token = await service.login({ email: 'a@b.com', password: 'right' } as any);

      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: number; exp: number; iat: number };
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
