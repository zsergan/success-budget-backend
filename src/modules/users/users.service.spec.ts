import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';

import { UsersService } from './users.service';
import { User } from '../../entities/user.entity';
import { ErrorMessages } from '../../shared/error-messages';

jest.mock('bcrypt', () => ({
  compare: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bcrypt = require('bcrypt') as { compare: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<Repository<User>>;
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
