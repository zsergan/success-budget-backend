import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import type { CreateUserDto } from './dto/create-user.dto';
import type { VerifyUserDto } from './dto/verify-user.dto';
import { buildUser } from '@testing';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            registerAndSendConfirmation: jest.fn(),
            verifyEmail: jest.fn(),
            login: jest.fn(),
            getProfile: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(UsersController);
    usersService = module.get(UsersService);
  });

  it('register delegates to UsersService.registerAndSendConfirmation', async () => {
    const dto: CreateUserDto = { email: 'a@b.com', name: 'A', password: 'StrongPass#1', base_currency_id: 1 };
    const user = buildUser({ id: 2, email: 'a@b.com', email_verified: 0 });
    usersService.registerAndSendConfirmation.mockResolvedValue(user);

    await expect(controller.register(dto)).resolves.toBe(user);
    expect(usersService.registerAndSendConfirmation).toHaveBeenCalledWith(dto);
  });

  it('verifyEmail delegates to UsersService.verifyEmail', async () => {
    const dto: VerifyUserDto = { email: 'x@x.com', code: '123456' };
    usersService.verifyEmail.mockResolvedValue('access-token');

    await expect(controller.verifyEmail(dto)).resolves.toBe('access-token');
    expect(usersService.verifyEmail).toHaveBeenCalledWith(dto);
  });

  it('login delegates to UsersService.login', async () => {
    usersService.login.mockResolvedValue('token');

    await expect(controller.login({ email: 'a@b.com', password: 'pw' })).resolves.toBe('token');
    expect(usersService.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
  });

  it('getProfile returns the authenticated user by id from the request', async () => {
    const user = buildUser({ id: 1, email: 'a@b.com' });
    usersService.getProfile.mockResolvedValue(user);

    await expect(controller.getProfile({ user: { id: 1 } })).resolves.toBe(user);
    expect(usersService.getProfile).toHaveBeenCalledWith(1);
  });
});
