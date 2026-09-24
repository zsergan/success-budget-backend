import type { DataSourceOptions } from 'typeorm';
import type { ConfigService } from '@nestjs/config';

import { buildDataSourceOptions } from './database.config';
import type { EnvironmentVariables } from './env.validation';

export const getOrmConfig = (configService: ConfigService<EnvironmentVariables, true>): DataSourceOptions =>
  buildDataSourceOptions({
    DB_HOST: configService.getOrThrow('DB_HOST', { infer: true }),
    DB_PORT: configService.getOrThrow('DB_PORT', { infer: true }),
    DB_USERNAME: configService.getOrThrow('DB_USERNAME', { infer: true }),
    DB_PASSWORD: configService.getOrThrow('DB_PASSWORD', { infer: true }),
    DB_DATABASE: configService.getOrThrow('DB_DATABASE', { infer: true }),
    DB_SSL: configService.get('DB_SSL', { infer: true }),
    DB_SSL_CA: configService.get('DB_SSL_CA', { infer: true }),
    DB_SSL_REJECT_UNAUTHORIZED: configService.get('DB_SSL_REJECT_UNAUTHORIZED', { infer: true }),
  });
