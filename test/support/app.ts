import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { DataSource } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.config';
import { UsersService } from '@modules/users/users.service';

export const PASSWORD = 'DevTest#2026';

export interface TestApp {
  app: INestApplication;
  dataSource: DataSource;
  currencyId: number;
  // the auth routes allow 5 requests a minute per IP, and every test runs from one IP
  resetThrottling(): void;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication();
  configureApp(app);
  // Bound once, to IPv4 loopback: supertest would otherwise listen(0) on every
  // interface per request and dial 127.0.0.1, which on macOS can reach another
  // local process that holds the same port number on 127.0.0.1 only.
  await app.listen(0, '127.0.0.1');

  const dataSource = moduleFixture.get(DataSource);
  const throttlerStorage = moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  const [currency] = await dataSource.query('SELECT id FROM currencies ORDER BY id LIMIT 1');

  return {
    app,
    dataSource,
    currencyId: currency.id,
    resetThrottling: () => throttlerStorage.storage.clear(),
  };
}

export function uniqueEmail(prefix: string): string {
  return `e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

export interface Member {
  userId: number;
  spaceId: number;
  token: string;
}

export async function createVerifiedMember({ app, dataSource, currencyId }: TestApp, prefix: string): Promise<Member> {
  const usersService = app.get(UsersService);
  const email = uniqueEmail(prefix);
  const user = await usersService.register({ name: 'E2E', email, password: PASSWORD, base_currency_id: currencyId });
  await usersService.completeEmailVerification(user.id);
  const token = await usersService.login({ email, password: PASSWORD });
  const [membership] = await dataSource.query('SELECT space_id FROM space_members WHERE user_id = ?', [user.id]);

  return { userId: user.id, spaceId: membership.space_id, token };
}

// Removes the users and everything in their spaces, children first:
// transactions and limit links reference categories with RESTRICT.
export async function deleteUsers(dataSource: DataSource, userIds: number[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  const members: { space_id: number }[] = await dataSource.query(
    'SELECT space_id FROM space_members WHERE user_id IN (?)',
    [userIds],
  );
  const spaceIds = members.map((member) => member.space_id);

  if (spaceIds.length) {
    await dataSource.query(
      'DELETE lc FROM limit_categories lc INNER JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?)',
      [spaceIds],
    );
    await dataSource.query('DELETE FROM limits WHERE space_id IN (?)', [spaceIds]);
    await dataSource.query(
      'DELETE t FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id IN (?)',
      [spaceIds],
    );
    await dataSource.query('DELETE FROM wallets WHERE space_id IN (?)', [spaceIds]);
    await dataSource.query('DELETE FROM space_members WHERE space_id IN (?)', [spaceIds]);
    await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
  }

  await dataSource.query('DELETE FROM users WHERE id IN (?)', [userIds]);
}
