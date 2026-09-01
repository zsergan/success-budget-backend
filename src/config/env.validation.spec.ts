import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  const validEnv = {
    DB_HOST: 'localhost',
    DB_PORT: '3306',
    DB_USERNAME: 'user',
    DB_PASSWORD: 'pass',
    DB_DATABASE: 'db',
    JWT_SECRET: 'a-very-long-secret-value',
  };

  it('accepts a fully populated, valid environment', () => {
    const { error } = envValidationSchema.validate(validEnv);

    expect(error).toBeUndefined();
  });

  it('rejects a missing required variable', () => {
    const rest: Partial<typeof validEnv> = { ...validEnv };
    delete rest.DB_HOST;

    const { error } = envValidationSchema.validate(rest);

    expect(error?.message).toContain('DB_HOST');
  });

  it('rejects a JWT_SECRET that is too short to be a real secret', () => {
    const { error } = envValidationSchema.validate({ ...validEnv, JWT_SECRET: 'short' });

    expect(error?.message).toContain('JWT_SECRET');
  });

  it('coerces DB_PORT into a number', () => {
    const { value, error } = envValidationSchema.validate(validEnv);

    expect(error).toBeUndefined();
    expect(value.DB_PORT).toBe(3306);
  });

  it('allows unrelated environment variables to pass through unrejected', () => {
    const { error } = envValidationSchema.validate({ ...validEnv, PATH: '/usr/bin' });

    expect(error).toBeUndefined();
  });
});
