import { envValidationSchema } from './env.validation';

describe('envValidationSchema', () => {
  const validEnv = {
    DB_HOST: 'localhost',
    DB_PORT: '3306',
    DB_USERNAME: 'user',
    DB_PASSWORD: 'pass',
    DB_DATABASE: 'db',
    JWT_SECRET: 'a-very-long-secret-value',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    MAIL_FROM: 'Success Budget <no-reply@success-budget.local>',
    PUBLIC_WEB_ORIGIN: 'https://app.example.com',
    INVITE_TOKEN_SECRET: 'an-invite-token-secret-of-32-chars-or-more',
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

  describe('invitation links', () => {
    const errorOf = (overrides: Record<string, string | undefined>) =>
      envValidationSchema.validate({ ...validEnv, ...overrides }).error?.message;

    it.each(['https://app.example.com', 'https://app.example.com:8443', 'http://localhost:3000', 'http://127.0.0.1'])(
      'accepts the origin %s',
      (origin) => {
        expect(errorOf({ PUBLIC_WEB_ORIGIN: origin })).toBeUndefined();
      },
    );

    it.each([
      'app.example.com',
      'https://app.example.com/',
      'https://app.example.com/invite',
      'https://app.example.com?x=1',
      'https://app.example.com#x',
      'https://user:pass@app.example.com',
      'http://app.example.com',
      'ftp://app.example.com',
      'https://APP.example.com',
    ])('rejects the origin %s', (origin) => {
      expect(errorOf({ PUBLIC_WEB_ORIGIN: origin })).toContain('PUBLIC_WEB_ORIGIN');
    });

    it('requires https even on a loopback host in production', () => {
      const production = { NODE_ENV: 'production', APPLE_APP_ID: 'ABCDE12345.com.example.app' };

      expect(errorOf({ ...production, PUBLIC_WEB_ORIGIN: 'http://localhost:3000' })).toContain('PUBLIC_WEB_ORIGIN');
      expect(errorOf({ ...production, PUBLIC_WEB_ORIGIN: 'https://app.example.com' })).toBeUndefined();
    });

    it('requires the origin and the signing secret', () => {
      expect(errorOf({ PUBLIC_WEB_ORIGIN: undefined })).toContain('PUBLIC_WEB_ORIGIN');
      expect(errorOf({ INVITE_TOKEN_SECRET: undefined })).toContain('INVITE_TOKEN_SECRET');
    });

    it('rejects a short signing secret or one equal to JWT_SECRET', () => {
      expect(errorOf({ INVITE_TOKEN_SECRET: 'too-short' })).toContain('INVITE_TOKEN_SECRET');
      expect(
        errorOf({ JWT_SECRET: validEnv.INVITE_TOKEN_SECRET, INVITE_TOKEN_SECRET: validEnv.INVITE_TOKEN_SECRET }),
      ).toBe('"INVITE_TOKEN_SECRET" must differ from JWT_SECRET');
    });

    it('requires the Apple app ID in production only, as <Team ID>.<bundle ID>', () => {
      expect(errorOf({})).toBeUndefined();
      expect(errorOf({ NODE_ENV: 'production' })).toContain('APPLE_APP_ID');
      expect(errorOf({ APPLE_APP_ID: 'ABCDE12345.com.zsergan.successbudget' })).toBeUndefined();

      for (const appId of [
        'com.zsergan.successbudget',
        'abcde12345.com.example',
        'ABCDE12345.app',
        'ABCDE1234.com.x',
      ]) {
        expect(errorOf({ APPLE_APP_ID: appId })).toContain('APPLE_APP_ID');
      }
    });

    it('accepts only a TestFlight https link as TESTFLIGHT_URL', () => {
      expect(errorOf({ TESTFLIGHT_URL: 'https://testflight.apple.com/join/AbCdEf12' })).toBeUndefined();

      for (const url of ['http://testflight.apple.com/join/x', 'https://example.com/join/x', 'testflight']) {
        expect(errorOf({ TESTFLIGHT_URL: url })).toContain('TESTFLIGHT_URL');
      }
    });
  });
});
