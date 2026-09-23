import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfirmationCodesService } from '@modules/confirmation-codes/confirmation-codes.service';
import { MailService } from '@modules/mail/mail.service';
import { ErrorMessages } from '@shared/error-messages';
import { ConfirmationType } from '@shared/enums';
import { RetryAfterException } from '@shared/retry-after.exception';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;
  let confirmationCodesService: jest.Mocked<ConfirmationCodesService>;
  let mailService: jest.Mocked<MailService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            registerOrRefresh: jest.fn(),
            verifyEmail: jest.fn(),
            login: jest.fn(),
            findById: jest.fn(),
          },
        },
        {
          provide: ConfirmationCodesService,
          useValue: { reserveSend: jest.fn(), markSent: jest.fn(), markFailed: jest.fn() },
        },
        {
          provide: MailService,
          useValue: { sendConfirmationCode: jest.fn() },
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UsersController);
    usersService = module.get(UsersService);
    confirmationCodesService = module.get(ConfirmationCodesService);
    mailService = module.get(MailService);
  });

  describe('register', () => {
    it('sends a confirmation email and marks the code sent when a new attempt is reserved', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const user = { id: 2, email: 'a@b.com' } as any;
      const expiresAt = new Date();
      usersService.registerOrRefresh.mockResolvedValue(user);
      confirmationCodesService.reserveSend.mockResolvedValue({
        id: 9,
        code: '123456',
        expiresAt,
        shouldSend: true,
        attemptId: 3,
      });

      const result = await controller.register(dto);

      expect(usersService.registerOrRefresh).toHaveBeenCalledWith(dto);
      expect(confirmationCodesService.reserveSend).toHaveBeenCalledWith(2, ConfirmationType.EMAIL);
      expect(mailService.sendConfirmationCode).toHaveBeenCalledWith('a@b.com', '123456', expiresAt);
      expect(confirmationCodesService.markSent).toHaveBeenCalledWith(9, 3);
      expect(confirmationCodesService.markFailed).not.toHaveBeenCalled();
      expect(result).toBe(user);
    });

    it('does not resend an email when the reservation reports it was already sent', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const user = { id: 2, email: 'a@b.com' } as any;
      usersService.registerOrRefresh.mockResolvedValue(user);
      confirmationCodesService.reserveSend.mockResolvedValue({
        id: 9,
        code: '123456',
        expiresAt: new Date(),
        shouldSend: false,
        attemptId: 1,
      });

      await controller.register(dto);

      expect(mailService.sendConfirmationCode).not.toHaveBeenCalled();
      expect(confirmationCodesService.markSent).not.toHaveBeenCalled();
    });

    it('propagates a rejection from the service (e.g. email already verified)', async () => {
      usersService.registerOrRefresh.mockRejectedValue(new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400));

      await expect(controller.register({ email: 'a@b.com' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
      );
      expect(confirmationCodesService.reserveSend).not.toHaveBeenCalled();
    });

    it('propagates a 429 with a retry delay when a send attempt is still in its cooldown', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const user = { id: 2, email: 'a@b.com' } as any;
      usersService.registerOrRefresh.mockResolvedValue(user);
      confirmationCodesService.reserveSend.mockRejectedValue(
        new RetryAfterException(ErrorMessages.CONFIRMATION_EMAIL_RATE_LIMITED, 42),
      );

      await expect(controller.register(dto)).rejects.toBeInstanceOf(RetryAfterException);
      expect(mailService.sendConfirmationCode).not.toHaveBeenCalled();
    });

    it('marks the code failed and propagates a controlled error when email delivery fails', async () => {
      const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
      const user = { id: 2, email: 'a@b.com' } as any;
      const expiresAt = new Date();
      usersService.registerOrRefresh.mockResolvedValue(user);
      confirmationCodesService.reserveSend.mockResolvedValue({
        id: 9,
        code: '123456',
        expiresAt,
        shouldSend: true,
        attemptId: 5,
      });
      mailService.sendConfirmationCode.mockRejectedValue(new HttpException('Could not send', 503));

      await expect(controller.register(dto)).rejects.toMatchObject(new HttpException('Could not send', 503));
      expect(confirmationCodesService.markFailed).toHaveBeenCalledWith(9, 5);
      expect(confirmationCodesService.markSent).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    it('delegates to UsersService.verifyEmail', async () => {
      const dto = { email: 'x@x.com', code: '1234' } as any;
      usersService.verifyEmail.mockResolvedValue('access-token');

      const result = await controller.verifyEmail(dto);

      expect(usersService.verifyEmail).toHaveBeenCalledWith(dto);
      expect(result).toBe('access-token');
    });

    it('propagates a rejection from the service (e.g. invalid code)', async () => {
      usersService.verifyEmail.mockRejectedValue(new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400));

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400),
      );
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
