import { readFileSync } from 'fs';
import { join } from 'path';
import type { DataSourceOptions } from 'typeorm';

export interface DatabaseEnv {
  DB_HOST: string;
  DB_PORT: number | string;
  DB_USERNAME: string;
  DB_PASSWORD: string;
  DB_DATABASE: string;
  DB_SSL?: string;
  DB_SSL_CA?: string;
  DB_SSL_REJECT_UNAUTHORIZED?: string;
}

interface MysqlSslOptions {
  ca?: string;
  rejectUnauthorized: boolean;
}

function buildSslOptions(env: DatabaseEnv): MysqlSslOptions | undefined {
  if (env.DB_SSL !== 'true') {
    return undefined;
  }

  // DB_SSL_CA can be either a filesystem path or the certificate's raw PEM
  // text - some hosting platforms only offer an env var, not a writable
  // path, to hand a managed database's CA certificate to the app.
  const ca = env.DB_SSL_CA
    ? env.DB_SSL_CA.includes('BEGIN CERTIFICATE')
      ? env.DB_SSL_CA
      : readFileSync(env.DB_SSL_CA, 'utf8')
    : undefined;

  return {
    ca,
    rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

/**
 * Shared between the Nest runtime (ormconfig.ts, via ConfigService) and the
 * TypeORM CLI (typeorm-cli.data-source.ts, via process.env directly) so the
 * two never drift apart on connection/TLS behavior.
 *
 * entities/migrations are resolved relative to this file's own directory,
 * so the same glob matches whether it runs via ts-node from src/config or
 * as compiled JS from dist/config.
 */
export function buildDataSourceOptions(env: DatabaseEnv): DataSourceOptions {
  return {
    type: 'mysql',
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    database: env.DB_DATABASE,
    ssl: buildSslOptions(env),
    entities: [join(__dirname, '../entities/**.entity{.ts,.js}')],
    migrations: [join(__dirname, '../migrations/**{.ts,.js}')],
    synchronize: false,
    // Migrations are a separate, explicit step everywhere (see the
    // migration:* scripts and README) - the app never changes the schema
    // on its own.
    migrationsRun: false,
  };
}
