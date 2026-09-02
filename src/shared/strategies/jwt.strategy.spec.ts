import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '@modules/users/users.service';

describe('JwtStrategy', () => {
  const configService = { getOrThrow: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService;

  it('maps the JWT payload to the request user shape when the user still exists', async () => {
    const usersService = { exists: jest.fn().mockResolvedValue(true) } as unknown as UsersService;
    const strategy = new JwtStrategy(configService, usersService);

    const result = await strategy.validate({ id: 42 });

    expect(usersService.exists).toHaveBeenCalledWith(42);
    expect(result).toEqual({ id: 42 });
  });

  it('rejects a token whose user no longer exists', async () => {
    const usersService = { exists: jest.fn().mockResolvedValue(false) } as unknown as UsersService;
    const strategy = new JwtStrategy(configService, usersService);

    await expect(strategy.validate({ id: 42 })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
