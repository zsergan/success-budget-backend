import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { buildDataSourceOptions } from './database.config';

describe('buildDataSourceOptions', () => {
  const baseEnv = {
    DB_HOST: 'db-host',
    DB_PORT: 3306,
    DB_USERNAME: 'user',
    DB_PASSWORD: 'pass',
    DB_DATABASE: 'success_budget',
  };

  it('builds a plain mysql DataSourceOptions with migrations never auto-run', () => {
    const options = buildDataSourceOptions(baseEnv);

    expect(options).toMatchObject({
      type: 'mysql',
      host: 'db-host',
      port: 3306,
      username: 'user',
      password: 'pass',
      database: 'success_budget',
      synchronize: false,
      migrationsRun: false,
    });
    expect(options.ssl).toBeUndefined();
  });

  it('leaves ssl undefined when DB_SSL is not exactly "true"', () => {
    expect(buildDataSourceOptions({ ...baseEnv, DB_SSL: 'false' }).ssl).toBeUndefined();
    expect(buildDataSourceOptions(baseEnv).ssl).toBeUndefined();
  });

  it('enables ssl with certificate validation on by default', () => {
    const options = buildDataSourceOptions({ ...baseEnv, DB_SSL: 'true' });

    expect(options.ssl).toEqual({ ca: undefined, rejectUnauthorized: true });
  });

  it('disables certificate validation only when explicitly told to', () => {
    const options = buildDataSourceOptions({ ...baseEnv, DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' });

    expect(options.ssl).toMatchObject({ rejectUnauthorized: false });
  });

  it('accepts a raw PEM certificate for DB_SSL_CA', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const options = buildDataSourceOptions({ ...baseEnv, DB_SSL: 'true', DB_SSL_CA: pem });

    expect(options.ssl).toMatchObject({ ca: pem });
  });

  it('accepts a filesystem path for DB_SSL_CA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-ssl-ca-'));
    const path = join(dir, 'ca.pem');
    writeFileSync(path, 'fake-ca-contents');

    const options = buildDataSourceOptions({ ...baseEnv, DB_SSL: 'true', DB_SSL_CA: path });

    expect(options.ssl).toMatchObject({ ca: 'fake-ca-contents' });
  });
});
