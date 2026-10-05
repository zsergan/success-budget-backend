import { QueryFailedError } from 'typeorm';

interface MysqlDriverError {
  code?: string;
  sqlMessage?: string;
}

function driverError(error: unknown): MysqlDriverError | undefined {
  return error instanceof QueryFailedError ? (error.driverError as MysqlDriverError) : undefined;
}

export function isDuplicateKey(error: unknown, constraint: string): boolean {
  const driver = driverError(error);

  return driver?.code === 'ER_DUP_ENTRY' && (driver.sqlMessage ?? '').includes(constraint);
}

export function isDeadlock(error: unknown): boolean {
  return driverError(error)?.code === 'ER_LOCK_DEADLOCK';
}
