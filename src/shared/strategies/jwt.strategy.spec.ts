import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '@modules/users/users.service';
import { buildConfigService } from '@testing';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: jest.Mocked<Pick<UsersService, 'exists'>>;

  beforeEach(async () => {
    usersService = { exists: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: buildConfigService({ JWT_SECRET: 'test-secret-value' }) },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    strategy = module.get(JwtStrategy);
  });

  it('maps the JWT payload to the request user shape when the user still exists', async () => {
    usersService.exists.mockResolvedValue(true);

    const result = await strategy.validate({ id: 42 });

    expect(usersService.exists).toHaveBeenCalledWith(42);
    expect(result).toEqual({ id: 42 });
  });

  it('rejects a token whose user no longer exists', async () => {
    usersService.exists.mockResolvedValue(false);

    await expect(strategy.validate({ id: 42 })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
