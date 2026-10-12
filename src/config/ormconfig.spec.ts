import { getOrmConfig } from './ormconfig';
import { buildConfigService } from '@testing';

describe('getOrmConfig', () => {
  it('builds mysql DataSourceOptions from validated config values', () => {
    const configService = buildConfigService({
      DB_HOST: 'db-host',
      DB_PORT: 3306,
      DB_USERNAME: 'user',
      DB_PASSWORD: 'pass',
      DB_DATABASE: 'success_budget',
    });

    const config = getOrmConfig(configService);

    expect(config).toMatchObject({
      type: 'mysql',
      host: 'db-host',
      port: 3306,
      username: 'user',
      password: 'pass',
      database: 'success_budget',
      synchronize: false,
      migrationsRun: false,
    });
  });
});
