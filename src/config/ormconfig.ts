import type { DataSourceOptions } from 'typeorm';
import { ConfigService } from '@nestjs/config';

import { buildDataSourceOptions } from './database.config';

export const getOrmConfig = (configService: ConfigService): DataSourceOptions =>
  buildDataSourceOptions({
    DB_HOST: configService.getOrThrow<string>('DB_HOST'),
    DB_PORT: configService.getOrThrow<number>('DB_PORT'),
    DB_USERNAME: configService.getOrThrow<string>('DB_USERNAME'),
    DB_PASSWORD: configService.getOrThrow<string>('DB_PASSWORD'),
    DB_DATABASE: configService.getOrThrow<string>('DB_DATABASE'),
    DB_SSL: configService.get<string>('DB_SSL'),
    DB_SSL_CA: configService.get<string>('DB_SSL_CA'),
    DB_SSL_REJECT_UNAUTHORIZED: configService.get<string>('DB_SSL_REJECT_UNAUTHORIZED'),
  });
