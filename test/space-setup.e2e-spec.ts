import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.config';
import { UsersService } from '@modules/users/users.service';
import { SpacesService } from '@modules/spaces/spaces.service';
import { User } from '@entities/user.entity';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { AppColor, SpaceRole, SpaceType } from '@shared/enums';
import { DEFAULT_CATEGORIES, INITIAL_BALANCE_CATEGORY } from '@shared/constants';

// Registration, email verification and POST /spaces each provision a
// different slice of a space's starting data inside one DB transaction.
// This checks the rows each one actually writes, and that a failure at the
// last write of each rolls every earlier write back, against real MySQL.
describe('Space setup across registration, verification and space creation (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let usersService: UsersService;
  let spacesService: SpacesService;
  let currencyId: number;
  const userIds: number[] = [];

  const expectedCategoryNames = [...DEFAULT_CATEGORIES, INITIAL_BALANCE_CATEGORY].map((c) => c.name).sort();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    usersService = moduleFixture.get(UsersService);
    spacesService = moduleFixture.get(SpacesService);

    const [currency] = await dataSource.query('SELECT id FROM currencies LIMIT 1');
    currencyId = currency.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (userIds.length) {
        const memberships: { space_id: number }[] = await dataSource.query(
          'SELECT DISTINCT space_id FROM space_members WHERE user_id IN (?)',
          [userIds],
        );
        const spaceIds = memberships.map((row) => row.space_id);

        if (spaceIds.length) {
          await dataSource.query('DELETE FROM space_invites WHERE space_id IN (?)', [spaceIds]);
          await dataSource.query('DELETE FROM space_members WHERE space_id IN (?)', [spaceIds]);
          await dataSource.query('DELETE FROM spaces WHERE id IN (?)', [spaceIds]);
        }

        await dataSource.query('DELETE FROM users WHERE id IN (?)', [userIds]);
      }
    } finally {
      await app.close();
    }
  });

  const newEmail = () => `e2e-setup-${Date.now()}-${Math.random()}@example.com`;

  async function register(email = newEmail()): Promise<User> {
    const user = await usersService.register({
      name: 'E2E Setup',
      email,
      password: 'DevTest#2026',
      base_currency_id: currencyId,
    });
    userIds.push(user.id);
    return user;
  }

  async function spaceData(spaceId: number) {
    const [members, wallets, categories, invites] = await Promise.all([
      dataSource.getRepository(SpaceMember).findBy({ space_id: spaceId }),
      dataSource.getRepository(Wallet).findBy({ space_id: spaceId }),
      dataSource.getRepository(Category).findBy({ space_id: spaceId }),
      dataSource.getRepository(SpaceInvite).findBy({ space_id: spaceId }),
    ]);
    return { members, wallets, categories, invites };
  }

  function failSavesOf(entity: typeof SpaceMember | typeof Category) {
    const originalSave = Repository.prototype.save;
    jest.spyOn(Repository.prototype, 'save').mockImplementation(function (this: Repository<any>, ...args: any[]) {
      if (this.target === entity) {
        return Promise.reject(new Error('injected failure'));
      }
      return (originalSave as any).apply(this, args);
    });
  }

  function expectDefaultCategories(categories: Category[]) {
    expect(categories.map((category) => category.name).sort()).toEqual(expectedCategoryNames);
    const system = categories.filter((category) => category.is_system === 1);
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ name: INITIAL_BALANCE_CATEGORY.name, transaction_type: 'income' });
  }

  it('registration creates the user, a personal space and its owner - no wallet, no categories', async () => {
    const user = await register();

    const memberships = await dataSource.getRepository(SpaceMember).findBy({ user_id: user.id });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe(SpaceRole.OWNER);

    const space = await dataSource.getRepository(Space).findOneByOrFail({ id: memberships[0].space_id });
    expect(space).toMatchObject({ name: 'Personal', type: SpaceType.PERSONAL, currency_id: currencyId });

    const data = await spaceData(space.id);
    expect(data.members).toHaveLength(1);
    expect(data.wallets).toHaveLength(0);
    expect(data.categories).toHaveLength(0);

    const stored = await dataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(stored.email_verified).toBe(0);
  });

  it('email verification adds one Cash wallet and the default categories to the personal space', async () => {
    const user = await register();

    await usersService.completeEmailVerification(user);

    const memberships = await dataSource.getRepository(SpaceMember).findBy({ user_id: user.id });
    expect(memberships).toHaveLength(1);

    const data = await spaceData(memberships[0].space_id);
    expect(data.members).toHaveLength(1);
    expect(data.wallets).toHaveLength(1);
    expect(data.wallets[0]).toMatchObject({ wallet_name: 'Cash', design: AppColor.SLATE });
    expectDefaultCategories(data.categories);

    const stored = await dataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(stored.email_verified).toBe(1);
  });

  it('creating a space adds the owner, the default categories and invites - no Cash wallet', async () => {
    const user = await register();

    const space = await spacesService.create(user.id, {
      name: `e2e-group-${Date.now()}`,
      type: SpaceType.GROUP,
      currency_id: currencyId,
      invites: ['invitee@example.com'],
    });

    expect(space).toMatchObject({ type: SpaceType.GROUP, currency_id: currencyId });
    const data = await spaceData(space.id);
    expect(data.members).toEqual([expect.objectContaining({ user_id: user.id, role: SpaceRole.OWNER })]);
    expect(data.wallets).toHaveLength(0);
    expectDefaultCategories(data.categories);
    expect(data.invites).toEqual([expect.objectContaining({ email: 'invitee@example.com', role: SpaceRole.MEMBER })]);
  });

  it('rolls registration back when the owner membership fails to save', async () => {
    const email = newEmail();
    const spacesBefore = await dataSource.getRepository(Space).count();
    failSavesOf(SpaceMember);

    await expect(
      usersService.register({ name: 'E2E Setup', email, password: 'DevTest#2026', base_currency_id: currencyId }),
    ).rejects.toThrow('injected failure');

    jest.restoreAllMocks();
    await expect(dataSource.getRepository(User).findOneBy({ email })).resolves.toBeNull();
    await expect(dataSource.getRepository(Space).count()).resolves.toBe(spacesBefore);
  });

  it('rolls email verification back when the default categories fail to save', async () => {
    const user = await register();
    const [membership] = await dataSource.getRepository(SpaceMember).findBy({ user_id: user.id });
    failSavesOf(Category);

    await expect(usersService.completeEmailVerification(user)).rejects.toThrow('injected failure');

    jest.restoreAllMocks();
    const data = await spaceData(membership.space_id);
    expect(data.wallets).toHaveLength(0);
    expect(data.categories).toHaveLength(0);
    const stored = await dataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(stored.email_verified).toBe(0);
  });

  it('rolls space creation back when the default categories fail to save', async () => {
    const user = await register();
    const name = `e2e-rollback-${Date.now()}`;
    failSavesOf(Category);

    await expect(
      spacesService.create(user.id, { name, type: SpaceType.GROUP, currency_id: currencyId }),
    ).rejects.toThrow('injected failure');

    jest.restoreAllMocks();
    await expect(dataSource.getRepository(Space).findOneBy({ name })).resolves.toBeNull();
    await expect(dataSource.getRepository(SpaceMember).countBy({ user_id: user.id })).resolves.toBe(1);
  });
});
