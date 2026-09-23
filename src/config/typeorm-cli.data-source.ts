import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

import { buildDataSourceOptions } from './database.config';

// No-op if there's no .env file (e.g. a hosting platform that injects real
// env vars directly) - dotenv only fills in values that aren't already set.
loadEnv();

const REQUIRED_VARS = ['DB_HOST', 'DB_PORT', 'DB_USERNAME', 'DB_PASSWORD', 'DB_DATABASE'] as const;
const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s) for migrations: ${missing.join(', ')}`);
}

export default new DataSource(
  buildDataSourceOptions({
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USERNAME: process.env.DB_USERNAME,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_DATABASE: process.env.DB_DATABASE,
    DB_SSL: process.env.DB_SSL,
    DB_SSL_CA: process.env.DB_SSL_CA,
    DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED,
  }),
);
