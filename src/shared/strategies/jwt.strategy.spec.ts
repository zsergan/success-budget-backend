import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';

import { JwtStrategy } from './jwt.strategy';
import { UsersService } from '@modules/users/users.service';
import { buildConfigService } from '@testing';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let usersService: jest.Mocked<Pick<UsersService, 'findAuthVersion'>>;

  beforeEach(async () => {
    usersService = { findAuthVersion: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: buildConfigService({ JWT_SECRET: 'test-secret-value' }) },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    strategy = module.get(JwtStrategy);
  });

  it('maps the JWT payload to the request user shape when the token has the current version', async () => {
    usersService.findAuthVersion.mockResolvedValue(3);

    const result = await strategy.validate({ id: 42, ver: 3 });

    expect(usersService.findAuthVersion).toHaveBeenCalledWith(42);
    expect(result).toEqual({ id: 42 });
  });

  it('rejects a token whose user no longer exists', async () => {
    usersService.findAuthVersion.mockResolvedValue(null);

    await expect(strategy.validate({ id: 42, ver: 1 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token issued before a password reset', async () => {
    usersService.findAuthVersion.mockResolvedValue(2);

    await expect(strategy.validate({ id: 42, ver: 1 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a version the user has never had', async () => {
    usersService.findAuthVersion.mockResolvedValue(2);

    await expect(strategy.validate({ id: 42, ver: 3 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('treats a token without a version as version 1', async () => {
    usersService.findAuthVersion.mockResolvedValue(1);

    await expect(strategy.validate({ id: 42 })).resolves.toEqual({ id: 42 });

    usersService.findAuthVersion.mockResolvedValue(2);

    await expect(strategy.validate({ id: 42 })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
