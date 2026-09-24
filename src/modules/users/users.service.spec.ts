import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import * as jwt from 'jsonwebtoken';

import { UsersService } from './users.service';
import { User } from '@entities/user.entity';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { MailService } from '@modules/mail/mail.service';
import { RetryAfterException } from '@shared/retry-after.exception';
import { ErrorMessages } from '@shared/error-messages';
import { ConfirmationType, SpaceRole, SpaceType } from '@shared/enums';
import type { CreateUserDto } from './dto/create-user.dto';
import { buildConfigService, buildConfirmationCode, buildUser } from '@testing';

const JWT_SECRET_FOR_TESTS = 'test-secret-value';

const mockCompare = jest.fn<Promise<boolean>, [string, string]>();
const mockHash = jest.fn<Promise<string>, [string, number]>();
jest.mock('bcrypt', () => ({
  compare: (...args: [string, string]) => mockCompare(...args),
  hash: (...args: [string, number]) => mockHash(...args),
  hashSync: () => 'dummy-password-hash',
}));

describe('UsersService', () => {
  let service: UsersService;
  let repository: jest.Mocked<Repository<User>>;
  let userRepositoryInTx: { create: jest.Mock; save: jest.Mock; update: jest.Mock };
  let lockedUser: { getOne: jest.Mock };
  let manager: { getRepository: jest.Mock; createQueryBuilder: jest.Mock };
  let walletRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let categoryRepositoryInTx: { save: jest.Mock };
  let spaceRepositoryInTx: { create: jest.Mock; save: jest.Mock; update: jest.Mock; findOneOrFail: jest.Mock };
  let spaceMemberRepositoryInTx: { create: jest.Mock; save: jest.Mock; findOneOrFail: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let confirmationCodesService: jest.Mocked<ConfirmationCodesService>;
  let mailService: jest.Mocked<Pick<MailService, 'sendConfirmationCode'>>;
  let inTransaction: boolean;

  beforeEach(async () => {
    userRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), update: jest.fn() };
    lockedUser = { getOne: jest.fn().mockResolvedValue(buildUser({ id: 1, email_verified: 0 })) };
    const userLockQueryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: (...args: unknown[]) => lockedUser.getOne(...args),
    };
    walletRepositoryInTx = { create: jest.fn(), save: jest.fn() };
    categoryRepositoryInTx = { save: jest.fn() };
    spaceRepositoryInTx = {
      create: jest.fn((entity) => entity),
      save: jest.fn(),
      update: jest.fn(),
      findOneOrFail: jest.fn(),
    };
    spaceMemberRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), findOneOrFail: jest.fn() };
    manager = {
      createQueryBuilder: jest.fn((entity) => {
        if (entity === User) return userLockQueryBuilder;
        throw new Error(`Unexpected query builder entity: ${entity}`);
      }),
      getRepository: jest.fn((entity) => {
        if (entity === User) return userRepositoryInTx;
        if (entity === Wallet) return walletRepositoryInTx;
        if (entity === Category) return categoryRepositoryInTx;
        if (entity === Space) return spaceRepositoryInTx;
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    inTransaction = false;
    dataSource = {
      transaction: jest.fn(async (callback) => {
        inTransaction = true;
        try {
          return await callback(manager);
        } finally {
          inTransaction = false;
        }
      }),
    };
    mailService = { sendConfirmationCode: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn(), update: jest.fn() },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: buildConfigService({ JWT_SECRET: JWT_SECRET_FOR_TESTS }) },
        {
          provide: ConfirmationCodesService,
          useValue: {
            lockActive: jest.fn(),
            expire: jest.fn(),
            incrementAttempts: jest.fn(),
            reserveSend: jest.fn(),
            markSent: jest.fn(),
            markFailed: jest.fn(),
          },
        },
        { provide: MailService, useValue: mailService },
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
    it('creates the user, a personal space, and an owner membership in one transaction', async () => {
      const dto: CreateUserDto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 };
      userRepositoryInTx.save.mockResolvedValue({ id: 1, email: 'a@b.com', name: 'A' });
      spaceRepositoryInTx.save.mockResolvedValue({ id: 10 });

      const result = await service.register(dto);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(userRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'A', email: 'a@b.com', password: 'pw' }),
      );
      expect(spaceRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 }),
      );
      expect(spaceMemberRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 10, user_id: 1, role: SpaceRole.OWNER }),
      );
      expect(result).toMatchObject({ id: 1, email: 'a@b.com' });
    });
  });

  describe('updateUnverified', () => {
    it('re-hashes the password, updates the personal space currency, and returns the refreshed user', async () => {
      const dto: CreateUserDto = { email: 'a@b.com', name: 'New Name', password: 'newpw', base_currency_id: 2 };
      mockHash.mockResolvedValue('hashed-newpw');
      spaceMemberRepositoryInTx.findOneOrFail.mockResolvedValue({ space_id: 20 });
      repository.findOne.mockResolvedValue(buildUser({ id: 4, name: 'New Name' }));

      const result = await service.updateUnverified(4, dto);

      expect(mockHash).toHaveBeenCalledWith('newpw', 10);
      expect(userRepositoryInTx.update).toHaveBeenCalledWith(4, { name: 'New Name', password: 'hashed-newpw' });
      expect(spaceMemberRepositoryInTx.findOneOrFail).toHaveBeenCalledWith({ where: { user_id: 4 } });
      expect(spaceRepositoryInTx.update).toHaveBeenCalledWith(20, { currency_id: 2 });
      expect(result).toMatchObject({ id: 4, name: 'New Name' });
    });

    it('locks the user and leaves an account verified in the meantime untouched', async () => {
      lockedUser.getOne.mockResolvedValue(buildUser({ id: 4, email_verified: 1 }));

      await expect(
        service.updateUnverified(4, { email: 'a@b.com', name: 'New', password: 'pw', base_currency_id: 2 }),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));

      expect(manager.createQueryBuilder).toHaveBeenCalledWith(User, 'user');
      expect(userRepositoryInTx.update).not.toHaveBeenCalled();
      expect(spaceRepositoryInTx.update).not.toHaveBeenCalled();
    });
  });

  describe('registerAndSendConfirmation', () => {
    const dto: CreateUserDto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 };
    const reservation = (overrides = {}) => ({
      id: 9,
      code: '123456',
      expiresAt: new Date(),
      shouldSend: true,
      attemptId: 3,
      ...overrides,
    });

    it('registers a new user, then sends the email outside the DB transaction and marks the code sent', async () => {
      repository.findOne.mockResolvedValue(null);
      userRepositoryInTx.save.mockResolvedValue({ id: 2, email: 'a@b.com' });
      spaceRepositoryInTx.save.mockResolvedValue({ id: 10 });
      const reserved = reservation();
      confirmationCodesService.reserveSend.mockResolvedValue(reserved);
      mailService.sendConfirmationCode.mockImplementation(async () => {
        expect(inTransaction).toBe(false);
      });

      const result = await service.registerAndSendConfirmation(dto);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(confirmationCodesService.reserveSend).toHaveBeenCalledWith(2, ConfirmationType.EMAIL);
      expect(mailService.sendConfirmationCode).toHaveBeenCalledWith('a@b.com', '123456', reserved.expiresAt);
      expect(confirmationCodesService.markSent).toHaveBeenCalledWith(9, 3);
      expect(confirmationCodesService.markFailed).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 2, email: 'a@b.com' });
    });

    it('does not resend an email when the reservation reports it was already sent', async () => {
      jest.spyOn(service, 'registerOrRefresh').mockResolvedValue(buildUser({ id: 2, email: 'a@b.com' }));
      confirmationCodesService.reserveSend.mockResolvedValue(reservation({ shouldSend: false, attemptId: 1 }));

      await service.registerAndSendConfirmation(dto);

      expect(mailService.sendConfirmationCode).not.toHaveBeenCalled();
      expect(confirmationCodesService.markSent).not.toHaveBeenCalled();
      expect(confirmationCodesService.markFailed).not.toHaveBeenCalled();
    });

    it('stops before reserving a send when the email already belongs to a verified user', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 1, email_verified: 1 }));

      await expect(service.registerAndSendConfirmation(dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
      );
      expect(confirmationCodesService.reserveSend).not.toHaveBeenCalled();
    });

    it('propagates a 429 with a retry delay when a send attempt is still in its cooldown', async () => {
      jest.spyOn(service, 'registerOrRefresh').mockResolvedValue(buildUser({ id: 2, email: 'a@b.com' }));
      confirmationCodesService.reserveSend.mockRejectedValue(
        new RetryAfterException(ErrorMessages.CONFIRMATION_EMAIL_RATE_LIMITED, 42),
      );

      await expect(service.registerAndSendConfirmation(dto)).rejects.toBeInstanceOf(RetryAfterException);
      expect(mailService.sendConfirmationCode).not.toHaveBeenCalled();
    });

    it('marks this attempt failed and propagates a controlled error when email delivery fails', async () => {
      jest.spyOn(service, 'registerOrRefresh').mockResolvedValue(buildUser({ id: 2, email: 'a@b.com' }));
      confirmationCodesService.reserveSend.mockResolvedValue(reservation({ attemptId: 5 }));
      mailService.sendConfirmationCode.mockRejectedValue(new HttpException('Could not send', 503));

      await expect(service.registerAndSendConfirmation(dto)).rejects.toMatchObject(
        new HttpException('Could not send', 503),
      );
      expect(confirmationCodesService.markFailed).toHaveBeenCalledWith(9, 5);
      expect(confirmationCodesService.markSent).not.toHaveBeenCalled();
    });
  });

  describe('registerOrRefresh', () => {
    it('rejects when the email already belongs to a verified user', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 1, email_verified: 1 }));

      await expect(
        service.registerOrRefresh({ email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 }),
      ).rejects.toMatchObject(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));
    });

    it('creates a new user when none exists yet', async () => {
      repository.findOne.mockResolvedValue(null);
      const dto: CreateUserDto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 };
      userRepositoryInTx.save.mockResolvedValue({ id: 2, email: 'a@b.com', name: 'A' });
      spaceRepositoryInTx.save.mockResolvedValue({ id: 10 });

      const result = await service.registerOrRefresh(dto);

      expect(userRepositoryInTx.save).toHaveBeenCalled();
      expect(result).toMatchObject({ id: 2 });
    });

    it('refreshes an existing unverified user instead of creating a duplicate', async () => {
      const existing = buildUser({ id: 3, email: 'a@b.com', email_verified: 0 });
      repository.findOne.mockResolvedValueOnce(existing).mockResolvedValueOnce(buildUser({ id: 3, name: 'New' }));
      mockHash.mockResolvedValue('hashed');
      spaceMemberRepositoryInTx.findOneOrFail.mockResolvedValue({ space_id: 20 });

      const dto: CreateUserDto = { email: 'a@b.com', name: 'New', password: 'newpw', base_currency_id: 1 };
      const result = await service.registerOrRefresh(dto);

      expect(userRepositoryInTx.update).toHaveBeenCalledWith(3, expect.objectContaining({ name: 'New' }));
      expect(result).toMatchObject({ id: 3, name: 'New' });
    });

    describe('when a concurrent registration inserts the same email first', () => {
      const dto: CreateUserDto = { email: 'a@b.com', name: 'Late', password: 'pw', base_currency_id: 1 };
      const duplicateEmail = () =>
        new QueryFailedError('INSERT INTO users', [], {
          code: 'ER_DUP_ENTRY',
          sqlMessage: "Duplicate entry 'a@b.com' for key 'users.UQ_users_email'",
        } as unknown as Error);

      beforeEach(() => {
        userRepositoryInTx.save.mockRejectedValue(duplicateEmail());
        mockHash.mockResolvedValue('hashed');
        spaceMemberRepositoryInTx.findOneOrFail.mockResolvedValue({ space_id: 20 });
      });

      it('re-reads the winner and refreshes it instead of creating another user', async () => {
        const winner = buildUser({ id: 9, email: 'a@b.com', email_verified: 0 });
        repository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(winner)
          .mockResolvedValueOnce(buildUser({ id: 9, name: 'Late' }));
        lockedUser.getOne.mockResolvedValue(winner);

        const result = await service.registerOrRefresh(dto);

        expect(spaceRepositoryInTx.save).not.toHaveBeenCalled();
        expect(userRepositoryInTx.update).toHaveBeenCalledWith(9, expect.objectContaining({ name: 'Late' }));
        expect(result).toMatchObject({ id: 9, name: 'Late' });
      });

      it('rejects when the winner is already verified', async () => {
        repository.findOne
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(buildUser({ id: 9, email: 'a@b.com', email_verified: 1 }));

        await expect(service.registerOrRefresh(dto)).rejects.toMatchObject(
          new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
        );
        expect(userRepositoryInTx.update).not.toHaveBeenCalled();
      });

      it('rethrows any other insert failure', async () => {
        const failure = new QueryFailedError('INSERT INTO users', [], {
          code: 'ER_DUP_ENTRY',
          sqlMessage: "Duplicate entry '1' for key 'users.PRIMARY'",
        } as unknown as Error);
        userRepositoryInTx.save.mockRejectedValue(failure);
        repository.findOne.mockResolvedValue(null);

        await expect(service.registerOrRefresh(dto)).rejects.toBe(failure);
        expect(repository.findOne).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('completeEmailVerification', () => {
    beforeEach(() => {
      spaceMemberRepositoryInTx.findOneOrFail.mockResolvedValue({ space_id: 20 });
      spaceRepositoryInTx.findOneOrFail.mockResolvedValue({ id: 20, currency_id: 5 });
      walletRepositoryInTx.create.mockReturnValue({ id: 10 });
    });

    it('locks the user, marks it verified and provisions the starter data in one transaction', async () => {
      await service.completeEmailVerification(1);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(User, 'user');
      expect(userRepositoryInTx.update).toHaveBeenCalledWith(1, { email_verified: 1 });
      expect(spaceMemberRepositoryInTx.findOneOrFail).toHaveBeenCalledWith({ where: { user_id: 1 } });
      expect(spaceRepositoryInTx.findOneOrFail).toHaveBeenCalledWith({ where: { id: 20 } });
      expect(walletRepositoryInTx.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 20, wallet_name: 'Cash' }),
      );
      expect(walletRepositoryInTx.save).toHaveBeenCalledWith({ id: 10 });
      expect(categoryRepositoryInTx.save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ space_id: 20, name: 'Initial balance', is_system: 1 })]),
      );
      expect(categoryRepositoryInTx.save.mock.calls[0][0]).toHaveLength(16);
    });

    it('is a no-op for a user that is already verified', async () => {
      lockedUser.getOne.mockResolvedValue(buildUser({ id: 1, email_verified: 1 }));

      await service.completeEmailVerification(1);

      expect(userRepositoryInTx.update).not.toHaveBeenCalled();
      expect(walletRepositoryInTx.save).not.toHaveBeenCalled();
      expect(categoryRepositoryInTx.save).not.toHaveBeenCalled();
    });

    it('propagates a failure from inside the transaction', async () => {
      walletRepositoryInTx.save.mockRejectedValue(new Error('db unavailable'));

      await expect(service.completeEmailVerification(1)).rejects.toThrow('db unavailable');
    });
  });

  describe('verifyEmail', () => {
    const dto = { email: 'x@x.com', code: '1234' };

    beforeEach(() => {
      repository.findOne.mockResolvedValue(buildUser({ id: 1, email_verified: 0 }));
      spaceMemberRepositoryInTx.findOneOrFail.mockResolvedValue({ space_id: 20 });
      spaceRepositoryInTx.findOneOrFail.mockResolvedValue({ id: 20, currency_id: 5 });
      walletRepositoryInTx.create.mockReturnValue({ id: 10 });
    });

    it('rejects when the user does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.verifyEmail(dto)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects an already verified user under the lock without looking at the code or issuing a token', async () => {
      lockedUser.getOne.mockResolvedValue(buildUser({ id: 1, email_verified: 1 }));

      await expect(service.verifyEmail(dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_VERIFIED, 409),
      );
      expect(confirmationCodesService.lockActive).not.toHaveBeenCalled();
      expect(userRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('locks the user before the code', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(
        buildConfirmationCode({ id: 7, confirmation_code: '1234' }),
      );

      await service.verifyEmail(dto);

      expect(confirmationCodesService.lockActive).toHaveBeenCalledWith(1, ConfirmationType.EMAIL, manager);
      expect(manager.createQueryBuilder.mock.invocationCallOrder[0]).toBeLessThan(
        confirmationCodesService.lockActive.mock.invocationCallOrder[0],
      );
    });

    it('rejects when there is no active confirmation code', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(null);

      await expect(service.verifyEmail(dto)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });

    it('commits the failed attempt and only then rejects a wrong code', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(
        buildConfirmationCode({ id: 7, confirmation_code: '9999', attempts: 0 }),
      );

      await expect(service.verifyEmail(dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400),
      );
      expect(confirmationCodesService.incrementAttempts).toHaveBeenCalledWith(7, manager);
      await expect(dataSource.transaction.mock.results[0].value).resolves.toBeInstanceOf(HttpException);
      expect(userRepositoryInTx.update).not.toHaveBeenCalled();
    });

    it('commits the expiry and only then rejects once the attempt limit is reached', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(
        buildConfirmationCode({ id: 7, confirmation_code: '9999', attempts: 5 }),
      );

      await expect(service.verifyEmail(dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, 429),
      );
      expect(confirmationCodesService.expire).toHaveBeenCalledWith(7, manager);
      await expect(dataSource.transaction.mock.results[0].value).resolves.toBeInstanceOf(HttpException);
      expect(confirmationCodesService.incrementAttempts).not.toHaveBeenCalled();
    });

    it('redeems the code, initializes the user and issues a token after the transaction', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(
        buildConfirmationCode({ id: 7, confirmation_code: '1234' }),
      );
      const signedInTransaction: boolean[] = [];
      const generateAccessToken = jest.spyOn(
        service as unknown as { generateAccessToken: (user: User) => string },
        'generateAccessToken',
      );
      generateAccessToken.mockImplementation(() => {
        signedInTransaction.push(inTransaction);
        return 'token';
      });

      const token = await service.verifyEmail(dto);

      expect(confirmationCodesService.expire).toHaveBeenCalledWith(7, manager);
      expect(userRepositoryInTx.update).toHaveBeenCalledWith(1, { email_verified: 1 });
      expect(walletRepositoryInTx.save).toHaveBeenCalled();
      expect(categoryRepositoryInTx.save).toHaveBeenCalled();
      expect(signedInTransaction).toEqual([false]);
      expect(token).toBe('token');
    });

    it('issues no token when initialization fails', async () => {
      confirmationCodesService.lockActive.mockResolvedValue(
        buildConfirmationCode({ id: 7, confirmation_code: '1234' }),
      );
      categoryRepositoryInTx.save.mockRejectedValue(new Error('db unavailable'));

      await expect(service.verifyEmail(dto)).rejects.toThrow('db unavailable');
    });
  });

  describe('login', () => {
    it('rejects when no user matches the email', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.login({ email: 'missing@x.com', password: 'pw' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );
    });

    it('still runs a bcrypt comparison when no user matches, to avoid a timing side-channel', async () => {
      repository.findOne.mockResolvedValue(null);
      mockCompare.mockResolvedValue(false);

      await expect(service.login({ email: 'missing@x.com', password: 'pw' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );

      expect(mockCompare).toHaveBeenCalledWith('pw', 'dummy-password-hash');
    });

    it('rejects when the password does not match', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 1, password: 'hashed' }));
      mockCompare.mockResolvedValue(false);

      await expect(service.login({ email: 'a@b.com', password: 'wrong' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 401),
      );
    });

    it('rejects when the email is not verified yet', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 3, password: 'hashed', email_verified: 0 }));
      mockCompare.mockResolvedValue(true);

      await expect(service.login({ email: 'a@b.com', password: 'right' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_NOT_VERIFIED, 403),
      );
    });

    it('returns an access token on valid credentials for a verified user', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 3, password: 'hashed', email_verified: 1 }));
      mockCompare.mockResolvedValue(true);

      const token = await service.login({ email: 'a@b.com', password: 'right' });

      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number };
      expect(decoded.id).toBe(3);
    });

    it('sets a ~90 day expiry, not 90000 days', async () => {
      repository.findOne.mockResolvedValue(buildUser({ id: 3, password: 'hashed', email_verified: 1 }));
      mockCompare.mockResolvedValue(true);

      const token = await service.login({ email: 'a@b.com', password: 'right' });

      const decoded = jwt.verify(token, JWT_SECRET_FOR_TESTS) as { id: number; exp: number; iat: number };
      const ninetyDaysInSeconds = 60 * 60 * 24 * 90;
      expect(decoded.exp - decoded.iat).toBe(ninetyDaysInSeconds);
    });
  });

  describe('getProfile', () => {
    it('returns the user', async () => {
      const user = buildUser({ id: 1, email: 'a@b.com' });
      repository.findOne.mockResolvedValue(user);

      await expect(service.getProfile(1)).resolves.toBe(user);
    });

    it('returns 404 when the user no longer exists', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.getProfile(1)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });
  });

  describe('findById', () => {
    it('looks up the user by id', async () => {
      const user = buildUser({ id: 1, email: 'a@b.com' });
      repository.findOne.mockResolvedValue(user);

      const result = await service.findById(1);

      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result).toEqual(user);
    });
  });

  describe('findByEmail', () => {
    it('looks up the user by email', async () => {
      const user = buildUser({ id: 1, email: 'a@b.com' });
      repository.findOne.mockResolvedValue(user);

      const result = await service.findByEmail('a@b.com');

      expect(repository.findOne).toHaveBeenCalledWith({ where: { email: 'a@b.com' } });
      expect(result).toEqual(user);
    });
  });
});
