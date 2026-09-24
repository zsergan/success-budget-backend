import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

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
            findById: jest.fn(),
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
    const dto = { email: 'a@b.com', name: 'A', password: 'pw', base_currency_id: 1 } as any;
    const user = { id: 2, email: 'a@b.com' } as any;
    usersService.registerAndSendConfirmation.mockResolvedValue(user);

    await expect(controller.register(dto)).resolves.toBe(user);
    expect(usersService.registerAndSendConfirmation).toHaveBeenCalledWith(dto);
  });

  it('verifyEmail delegates to UsersService.verifyEmail', async () => {
    const dto = { email: 'x@x.com', code: '1234' } as any;
    usersService.verifyEmail.mockResolvedValue('access-token');

    await expect(controller.verifyEmail(dto)).resolves.toBe('access-token');
    expect(usersService.verifyEmail).toHaveBeenCalledWith(dto);
  });

  it('login delegates to UsersService.login', async () => {
    usersService.login.mockResolvedValue('token');

    await expect(controller.login({ email: 'a@b.com', password: 'pw' } as any)).resolves.toBe('token');
    expect(usersService.login).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
  });

  it('getProfile returns the authenticated user by id from the request', async () => {
    const user = { id: 1, email: 'a@b.com' } as any;
    usersService.findById.mockResolvedValue(user);

    await expect(controller.getProfile({ user: { id: 1 } } as any)).resolves.toBe(user);
    expect(usersService.findById).toHaveBeenCalledWith(1);
  });
});
