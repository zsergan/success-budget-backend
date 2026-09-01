import { ConfigService } from '@nestjs/config';

import { getOrmConfig } from './ormconfig';

describe('getOrmConfig', () => {
  it('builds mysql DataSourceOptions from validated config values', () => {
    const values: Record<string, unknown> = {
      DB_HOST: 'db-host',
      DB_PORT: 3306,
      DB_USERNAME: 'user',
      DB_PASSWORD: 'pass',
      DB_DATABASE: 'success_budget',
    };
    const configService = { getOrThrow: jest.fn((key: string) => values[key]) } as unknown as ConfigService;

    const config = getOrmConfig(configService);

    expect(config).toMatchObject({
      type: 'mysql',
      host: 'db-host',
      port: 3306,
      username: 'user',
      password: 'pass',
      database: 'success_budget',
      synchronize: false,
      migrationsRun: true,
    });
  });
});
