import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { WalletsService } from '../wallets/wallets.service';
import { ConfirmationCodesService } from '../confirmation-codes/confirmation-codes.service';
import { CategoriesService } from '../categories/categories.service';
import { ErrorMessages } from '../../shared/error-messages';
import { ConfirmationType } from '../../shared/enums';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;
  let walletsService: jest.Mocked<WalletsService>;
  let confirmationCodesService: jest.Mocked<ConfirmationCodesService>;
  let categoriesService: jest.Mocked<CategoriesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
            register: jest.fn(),
            verify: jest.fn(),
            login: jest.fn(),
            findById: jest.fn(),
          },
        },
        { provide: WalletsService, useValue: { create: jest.fn() } },
        {
          provide: ConfirmationCodesService,
          useValue: { getOne: jest.fn(), create: jest.fn(), expire: jest.fn() },
        },
        { provide: CategoriesService, useValue: { initiateCategories: jest.fn() } },
      ],
    }).compile();

    controller = module.get(UsersController);
    usersService = module.get(UsersService);
    walletsService = module.get(WalletsService);
    confirmationCodesService = module.get(ConfirmationCodesService);
    categoriesService = module.get(CategoriesService);
  });

  describe('register', () => {
    it('rejects when the email already belongs to a verified user', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 1, email_verified: 1 } as any);

      await expect(controller.register({ email: 'a@b.com' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, 400),
      );
      expect(usersService.register).not.toHaveBeenCalled();
    });

    it('creates a new user and a confirmation code when none exists yet', async () => {
      usersService.findByEmail.mockResolvedValue(null);
      const created = { id: 2, email: 'a@b.com' } as any;
      usersService.register.mockResolvedValue(created);
      confirmationCodesService.getOne.mockResolvedValue(null);

      const result = await controller.register({ email: 'a@b.com' } as any);

      expect(usersService.register).toHaveBeenCalled();
      expect(confirmationCodesService.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 2, confirmation_type: ConfirmationType.EMAIL }),
      );
      expect(result).toBe(created);
    });

    it('re-uses an existing unverified user and skips creating a duplicate confirmation code', async () => {
      const existing = { id: 3, email: 'a@b.com', email_verified: 0 } as any;
      usersService.findByEmail.mockResolvedValue(existing);
      confirmationCodesService.getOne.mockResolvedValue({ id: 9 } as any);

      const result = await controller.register({ email: 'a@b.com' } as any);

      expect(usersService.register).not.toHaveBeenCalled();
      expect(confirmationCodesService.create).not.toHaveBeenCalled();
      expect(result).toBe(existing);
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

    it('rejects when the code does not match', async () => {
      usersService.findByEmail.mockResolvedValue({ id: 1 } as any);
      confirmationCodesService.getOne.mockResolvedValue({ confirmation_code: '9999' } as any);

      await expect(controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_CREDENTIALS, 400),
      );
    });

    it('verifies the user, creates a default wallet and default categories on success', async () => {
      const user = { id: 1, base_currency_id: 5 } as any;
      usersService.findByEmail.mockResolvedValue(user);
      confirmationCodesService.getOne.mockResolvedValue({ confirmation_code: '1234' } as any);
      usersService.verify.mockResolvedValue('access-token');

      const result = await controller.verifyEmail({ email: 'x@x.com', code: '1234' } as any);

      expect(usersService.verify).toHaveBeenCalledWith(1);
      expect(confirmationCodesService.expire).toHaveBeenCalledWith(1, ConfirmationType.EMAIL);
      expect(walletsService.create).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ wallet_name: 'Cash', currency_id: 5 }),
      );
      expect(categoriesService.initiateCategories).toHaveBeenCalledWith(1, expect.any(Array));
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
