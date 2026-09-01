import { ConfigService } from '@nestjs/config';

import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  it('maps the JWT payload to the request user shape', () => {
    const configService = { getOrThrow: jest.fn().mockReturnValue('test-secret') } as unknown as ConfigService;
    const strategy = new JwtStrategy(configService);

    const result = strategy.validate({ id: 42 });

    expect(result).toEqual({ id: 42 });
  });
});
