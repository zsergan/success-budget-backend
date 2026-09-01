import type { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';

export const getOrmConfig = (configService: ConfigService): DataSourceOptions => ({
  type: 'mysql',
  host: configService.getOrThrow<string>('DB_HOST'),
  port: configService.getOrThrow<number>('DB_PORT'),
  username: configService.getOrThrow<string>('DB_USERNAME'),
  password: configService.getOrThrow<string>('DB_PASSWORD'),
  database: configService.getOrThrow<string>('DB_DATABASE'),
  entities: [join(__dirname, '../entities/**.entity{.ts,.js}')],
  migrations: [join(__dirname, '../migrations/**{.ts,.js}')],
  synchronize: false,
  migrationsRun: true,
});
