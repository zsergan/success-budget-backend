import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Repository, type ObjectLiteral } from 'typeorm';

import {
  SAMPLE_LIMIT,
  SAMPLE_TRANSACTIONS,
  TESTFLIGHT_USER_NAME,
  provisionTestFlightAccount,
} from '../src/database/testflight-account';
import { MailService } from '@modules/mail/mail.service';
import { UsersService } from '@modules/users/users.service';
import { Limit } from '@entities/limit.entity';
import { User } from '@entities/user.entity';
import { DEFAULT_CATEGORIES } from '@shared/constants';
import { TransactionType } from '@shared/enums';
import { type TestApp, createTestApp, deleteUsers, uniqueEmail } from './support/app';

const DEMO_PASSWORD = 'Demo-pass-2026';

const cents = (amount: string) => Math.round(Number(amount) * 100);
const sampleTotal = (type: TransactionType, category?: string) =>
  SAMPLE_TRANSACTIONS.filter((sample) => sample.type === type && (!category || sample.category === category)).reduce(
    (sum, sample) => sum + cents(sample.amount),
    0,
  );

// Provisioning runs outside Nest, against the same database the app reads.
describe('TestFlight account provisioning (e2e)', () => {
  let testApp: TestApp;
  let emails: string[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    jest.restoreAllMocks();

    if (emails.length) {
      const users: { id: number }[] = await testApp.dataSource.query('SELECT id FROM users WHERE email IN (?)', [
        emails,
      ]);
      await deleteUsers(
        testApp.dataSource,
        users.map((user) => user.id),
      );
    }

    emails = [];
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  function newEmail(): string {
    const email = uniqueEmail('testflight');
    emails.push(email);
    return email;
  }

  const provision = (email: string, password = DEMO_PASSWORD, now?: Date) =>
    provisionTestFlightAccount(testApp.dataSource, { email, password }, now);

  async function rows<T = Record<string, unknown>>(sql: string, ids: number[]): Promise<T[]> {
    return ids.length ? testApp.dataSource.query(sql, [ids]) : [];
  }

  // every row the account owns, to compare before and after a run
  async function accountState(email: string) {
    const users = await testApp.dataSource.query(
      'SELECT id, name, password, email_verified, auth_version, updated_at FROM users WHERE email = ?',
      [email],
    );
    const members = await rows<{ space_id: number }>(
      'SELECT * FROM space_members WHERE user_id IN (?) ORDER BY id',
      users.map((user: { id: number }) => user.id),
    );
    const spaceIds = members.map((member) => member.space_id);

    return {
      users,
      members,
      spaces: await rows('SELECT * FROM spaces WHERE id IN (?) ORDER BY id', spaceIds),
      wallets: await rows('SELECT * FROM wallets WHERE space_id IN (?) ORDER BY id', spaceIds),
      categories: await rows('SELECT * FROM categories WHERE space_id IN (?) ORDER BY id', spaceIds),
      transactions: await rows(
        'SELECT t.* FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.space_id IN (?) ORDER BY t.id',
        spaceIds,
      ),
      limits: await rows('SELECT * FROM limits WHERE space_id IN (?) ORDER BY id', spaceIds),
      limitCategories: await rows(
        'SELECT lc.* FROM limit_categories lc JOIN limits l ON l.id = lc.limit_id WHERE l.space_id IN (?) ' +
          'ORDER BY lc.limit_id, lc.category_id',
        spaceIds,
      ),
    };
  }

  async function tableCounts() {
    const tables = ['users', 'spaces', 'space_members', 'wallets', 'categories', 'transactions', 'limits'];
    const counts = await Promise.all(
      tables.map(async (table) => {
        const [row] = await testApp.dataSource.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
        return [table, Number(row.count)];
      }),
    );
    return Object.fromEntries(counts);
  }

  function expectOneCompleteAccount(state: Awaited<ReturnType<typeof accountState>>) {
    expect(state.users).toHaveLength(1);
    expect(state.members).toHaveLength(1);
    expect(state.spaces).toHaveLength(1);
    expect(state.wallets).toHaveLength(1);
    expect(state.categories).toHaveLength(DEFAULT_CATEGORIES.length + 1);
    expect(state.transactions).toHaveLength(SAMPLE_TRANSACTIONS.length);
    expect(state.limits).toHaveLength(1);
    expect(state.limitCategories).toHaveLength(1);
  }

  it('creates one verified account with the demo data that signs in through the normal login', async () => {
    const mail = testApp.app.get(MailService);
    const sends = [jest.spyOn(mail, 'sendConfirmationCode'), jest.spyOn(mail, 'sendPasswordResetCode')];
    const email = newEmail();
    const startedAt = Date.now();

    await expect(provision(email)).resolves.toBe('created');

    const state = await accountState(email);
    expectOneCompleteAccount(state);
    const [user] = state.users;
    expect(user).toMatchObject({ name: TESTFLIGHT_USER_NAME, email_verified: 1 });
    expect(user.password).not.toBe(DEMO_PASSWORD);
    await expect(bcrypt.compare(DEMO_PASSWORD, user.password)).resolves.toBe(true);
    expect(state.members[0]).toMatchObject({ user_id: user.id, role: 'owner' });
    const [usd] = await testApp.dataSource.query("SELECT id FROM currencies WHERE code = 'USD'");
    expect(state.spaces[0]).toMatchObject({ name: 'Personal', type: 'personal', currency_id: usd.id });
    expect(state.wallets[0]).toMatchObject({ wallet_name: 'Cash', design: 'slate', is_deleted: 0 });
    expect(state.categories.filter((category) => category.is_system === 1)).toEqual([
      expect.objectContaining({ name: 'Initial balance' }),
    ]);

    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    for (const transaction of state.transactions as { timestamp: Date }[]) {
      expect(transaction.timestamp.getTime()).toBeGreaterThanOrEqual(Math.min(monthStart, startedAt));
      expect(transaction.timestamp.getTime()).toBeLessThanOrEqual(now.getTime());
    }

    testApp.resetThrottling();
    const server = testApp.app.getHttpServer();
    const login = await request(server)
      .post('/api/v1/users/login')
      .send({ email, password: DEMO_PASSWORD })
      .expect(201);
    const api = (path: string) =>
      request(server).get(`/api/v1${path}`).set('Authorization', `Bearer ${login.text}`).expect(200);
    const spaceId = state.spaces[0].id;

    const spaces = await api('/spaces');
    expect(spaces.body).toEqual([expect.objectContaining({ id: spaceId, type: 'personal' })]);

    const categories = await api(`/spaces/${spaceId}/categories`);
    const names = (type: TransactionType) =>
      DEFAULT_CATEGORIES.filter((category) => category.transaction_type === type).map((category) => category.name);
    expect(categories.body.incomes.map((category: { name: string }) => category.name)).toEqual(
      names(TransactionType.INCOME),
    );
    expect(categories.body.expenses.map((category: { name: string }) => category.name)).toEqual(
      names(TransactionType.EXPENSE),
    );

    const wallets = await api(`/spaces/${spaceId}/wallets`);
    expect(wallets.body.total_balance_currency).toBe('USD');
    expect(Math.round(wallets.body.total_balance * 100)).toBe(
      sampleTotal(TransactionType.INCOME) - sampleTotal(TransactionType.EXPENSE),
    );

    const latest = await api(`/spaces/${spaceId}/transactions/latest`);
    const newest = SAMPLE_TRANSACTIONS.reduce((last, sample) => (sample.at > last.at ? sample : last));
    expect(latest.body).toMatchObject({ amount: newest.amount, description: newest.description });

    const limits = await api(`/spaces/${spaceId}/limits?time_zone=UTC`);
    const spent = sampleTotal(TransactionType.EXPENSE, SAMPLE_LIMIT.category);
    expect(limits.body.total).toBeNull();
    expect(limits.body.categories).toEqual([
      expect.objectContaining({
        amount: SAMPLE_LIMIT.amount,
        spent: spent / 100,
        in_percent: Math.floor((spent / cents(SAMPLE_LIMIT.amount)) * 100),
        categories: [expect.objectContaining({ name: SAMPLE_LIMIT.category })],
      }),
    ]);
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(cents(SAMPLE_LIMIT.amount));

    for (const send of sends) {
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('rolls every write back when the last one fails', async () => {
    const email = newEmail();
    const before = await tableCounts();
    const originalSave = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function (
      this: Repository<ObjectLiteral>,
      ...args: Parameters<typeof originalSave>
    ) {
      if (this.target === Limit) {
        return Promise.reject(new Error('injected failure'));
      }
      return Reflect.apply(originalSave, this, args);
    });

    await expect(provision(email)).rejects.toThrow('injected failure');

    jest.restoreAllMocks();
    await expect(tableCounts()).resolves.toEqual(before);
    expect((await accountState(email)).users).toHaveLength(0);
  });

  it('changes nothing on a repeat run, keeping what testers changed', async () => {
    const email = newEmail();
    await provision(email);
    const { users, spaces, transactions, limits } = await accountState(email);

    await testApp.dataSource.query("UPDATE users SET name = 'Tester' WHERE id = ?", [users[0].id]);
    await testApp.dataSource.query('DELETE FROM transactions WHERE id = ?', [transactions[0].id]);
    await testApp.dataSource.query("UPDATE limits SET amount = '150.00' WHERE id = ?", [limits[0].id]);
    await testApp.dataSource.query("UPDATE categories SET name = 'Food' WHERE space_id = ? AND name = 'Groceries'", [
      spaces[0].id,
    ]);
    const changed = await accountState(email);

    await expect(provision(email, DEMO_PASSWORD, new Date(Date.now() + 60_000))).resolves.toBe('existing');
    await expect(accountState(email)).resolves.toEqual(changed);

    // a tester reset the password
    const newHash = await bcrypt.hash('Tester-pass-77', 10);
    await testApp.dataSource.query('UPDATE users SET password = ?, auth_version = auth_version + 1 WHERE id = ?', [
      newHash,
      users[0].id,
    ]);
    const reset = await accountState(email);

    await expect(provision(email)).rejects.toThrow('does not accept this password. Nothing was changed.');
    await expect(accountState(email)).resolves.toEqual(reset);
    await expect(provision(email, 'Tester-pass-77')).resolves.toBe('existing');
    await expect(accountState(email)).resolves.toEqual(reset);
  });

  it('creates exactly one account when runs race', async () => {
    const email = newEmail();
    // every run passes the existence check, so only the unique email decides
    const originalFindOneBy = Repository.prototype.findOneBy;
    let checks = 0;
    jest.spyOn(Repository.prototype, 'findOneBy').mockImplementation(function (
      this: Repository<ObjectLiteral>,
      ...args: Parameters<typeof originalFindOneBy>
    ) {
      if (this.target === User) {
        checks++;
        return Promise.resolve(null);
      }
      return Reflect.apply(originalFindOneBy, this, args);
    });

    const outcomes = await Promise.all([provision(email), provision(email), provision(email)]);

    expect(checks).toBe(3);
    expect(outcomes.sort()).toEqual(['created', 'existing', 'existing']);
    expectOneCompleteAccount(await accountState(email));
  });

  it.each([
    ['a verified account with another password', 'Owner-pass-2026', true, 'does not accept this password'],
    ['an unverified account with the same password', DEMO_PASSWORD, false, 'its email is not verified'],
  ])('refuses %s and changes nothing', async (_case, password, verified, problem) => {
    const email = newEmail();
    const usersService = testApp.app.get(UsersService);
    const user = await usersService.register({ name: 'Owner', email, password, base_currency_id: testApp.currencyId });
    if (verified) {
      await usersService.completeEmailVerification(user.id);
    }
    const before = await accountState(email);

    await expect(provision(email)).rejects.toThrow(`${problem}. Nothing was changed.`);

    await expect(accountState(email)).resolves.toEqual(before);
    expect(before.users[0]).toMatchObject({ name: 'Owner', email_verified: verified ? 1 : 0 });
  });

  it('runs as a command that creates the account once and then only checks it', async () => {
    const email = newEmail();
    const run = (password: string) =>
      promisify(execFile)('npm', ['run', '--silent', 'seed:testflight'], {
        env: { ...process.env, TESTFLIGHT_USER_EMAIL: email, TESTFLIGHT_USER_PASSWORD: password },
      });

    await expect(run(DEMO_PASSWORD)).resolves.toMatchObject({
      stdout: expect.stringContaining(`Created the TestFlight account ${email}.`),
    });
    await expect(run(DEMO_PASSWORD)).resolves.toMatchObject({
      stdout: expect.stringContaining('already exists and accepts this password. Nothing was changed.'),
    });

    const wrong = 'Wrong-pass-2026';
    const failure = await run(wrong).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(failure).toMatchObject({ code: 1, stderr: expect.stringContaining('does not accept this password') });
    expect(`${failure.stdout}${failure.stderr}`).not.toContain(wrong);

    expectOneCompleteAccount(await accountState(email));
  }, 60_000);
});
