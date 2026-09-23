import { ConfigService } from '@nestjs/config';

import { isSwaggerEnabled, parseTrustProxy } from './app.config';

describe('parseTrustProxy', () => {
  it('defaults to false when unset', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
  });

  it('parses explicit booleans', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses a hop count as a number', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes through anything else as-is (CIDR/hostname lists)', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});

describe('isSwaggerEnabled', () => {
  const buildConfigService = (values: Record<string, string | undefined>) =>
    ({ get: jest.fn((key: string) => values[key]) }) as unknown as ConfigService;

  it('is disabled in production by default', () => {
    expect(isSwaggerEnabled(buildConfigService({ NODE_ENV: 'production' }))).toBe(false);
  });

  it('is enabled outside production by default', () => {
    expect(isSwaggerEnabled(buildConfigService({ NODE_ENV: 'staging' }))).toBe(true);
    expect(isSwaggerEnabled(buildConfigService({}))).toBe(true);
  });

  it('lets SWAGGER_ENABLED override the NODE_ENV default in either direction', () => {
    expect(isSwaggerEnabled(buildConfigService({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }))).toBe(true);
    expect(isSwaggerEnabled(buildConfigService({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }))).toBe(false);
  });
});
