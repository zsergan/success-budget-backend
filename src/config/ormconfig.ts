import type { DataSourceOptions } from 'typeorm';
import { join } from 'path';
import 'dotenv/config';

export const ormConfig: DataSourceOptions = {
  type: 'mysql',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  entities: [join(__dirname, '../entities/**.entity{.ts,.js}')],
  migrations: [join(__dirname, '../migrations/**{.ts,.js}')],
  synchronize: false,
  migrationsRun: true,
};
