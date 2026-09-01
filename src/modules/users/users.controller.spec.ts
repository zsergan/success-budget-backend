import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType } from '../../shared/enums';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;
  let confirmationCodesService: jest.Mocked<ConfirmationCodesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            registerOrRefresh: jest.fn(),
            verify: jest.fn(),
            completeEmailVerification: jest.fn(),
            login: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: ConfirmationCodesService,
          useValue: {
            getOne: jest.fn(),
            ensureCode: jest.fn(),
            expire: jest.fn(),
            incrementAttempts: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UsersController);
    usersService = module.get(UsersService);
    confirmationCodesService = module.get(ConfirmationCodesService);
  });

  describe('register', () => {
    it('delegates to UsersService and ensures a confirmation code exists', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const user = { id: 2, email: 'a@b.com' } as any;
      usersService.registerOrRefresh.mockResolvedValue(user);

      const result = await controller.register(dto);

      expect(usersService.registerOrRefresh).toHaveBeenCalledWith(dto);
      expect(confirmationCodesService.ensureCode).toHaveBeenCalledWith(2, ConfirmationType.EMAIL);
      expect(result).toBe(user);
    });

    it('propagates a rejection from the service (e.g. email already verified)', async () => {
      usersService.registerOrRefresh.mockRejectedValue(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));

      await expect(controller.register({ email: 'a@b.com' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
      );
      expect(confirmationCodesService.ensureCode).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('rejects when the user does not exist', async () => {
      usersService.findByEmail.mockResolvedValue(null);

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
    });

    it('rejects when there is no active confirmation code', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 1 } as any);
      confirmationCodesService.getOne.mockResolvedValue(null);

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
    });

    it('rejects when the code does not match and records the failed attempt', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 1 } as any);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '9999', attempts: 0 } as any);

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400),
      );
      expect(confirmationCodesService.incrementAttempts).toHaveBeenCalledWith(7);
    });

    it('rejects and expires the code once the attempt limit is reached', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 1 } as any);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '9999', attempts: 5 } as any);

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.TOO_MANY_ATTEMPTS, 429),
      );
      expect(confirmationCodesService.expire).toHaveBeenCalledWith(1, ConfirmationType.EMAIL);
      expect(confirmationCodesService.incrementAttempts).not.toHaveBeenCalled();
    });

    it('completes email verification on a matching code', async () => {
      const user = { id: 1, base_currency_id: 5 } as any;
      usersService.findByEmail.mockResolvedValue(user);
      confirmationCodesService.getOne.mockResolvedValue({ id: 7, confirmation_code: '1234' } as any);
      usersService.completeEmailVerification.mockResolvedValue('access-token');

      const result = await controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any);

      expect(usersService.completeEmailVerification).toHaveBeenCalledWith(user, 7);
      expect(result).toBe('access-token');
    });
  });

  describe('login', () => {
    it('delegates to UsersService.login', async () => {
      usersService.login.mockResolvedValue('token');

      const result = await controller.login({ email: 'a@b.com', password: 'pw' } as any);

      expect(usersService.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
      expect(result).toBe('token');
    });
  });

  describe('getProfile', () => {
    it('returns the authenticated user by id from the request', async () => {
      const user = { id: 1, email: 'a@b.com' } as any;
      usersService.findById.mockResolvedValue(user);

      const result = await controller.getProfile({ user: { id: 1 } } as any);

      expect(usersService.findById).toHaveBeenCalledWith(1);
      expect(result).toBe(user);
    });
  });
});
