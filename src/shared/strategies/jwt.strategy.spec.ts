import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  it('maps the JWT payload to the request user shape', () => {
    const strategy = new JwtStrategy();

    const result = strategy.validate({ id: 42 });

    expect(result).toEqual({ id: 42 });
  });
});
