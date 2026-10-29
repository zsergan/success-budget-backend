import { IsEmail, IsNotEmpty, MaxLength, validateSync } from 'class-validator';
import * as bcrypt from 'bcrypt';
import type { DataSource, EntityManager } from 'typeorm';

import { User } from '@entities/user.entity';
import { Currency } from '@entities/currency.entity';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { createDefaultCategories, createSpaceWithOwner } from '@modules/spaces/space-setup';
import { IsNewPassword } from '@shared/decorators/is-new-password.decorator';
import { AppColor, LimitType, SpaceType, TransactionType } from '@shared/enums';
import { isDuplicateKey, runWriteTransaction } from '@shared/utils';

export const TESTFLIGHT_USER_NAME = 'TestFlight Demo';

export const TESTFLIGHT_CURRENCY_CODE = 'USD';

export interface TestFlightAccountInput {
  email: string;
  password: string;
}

export type ProvisionOutcome = 'created' | 'existing';

interface SampleTransaction {
  type: TransactionType;
  category: string;
  amount: string;
  // share of the current UTC month elapsed at the first run: every sample is
  // in the past, and this month's spending shows against the limit
  at: number;
  description: string;
}

export const SAMPLE_TRANSACTIONS: readonly SampleTransaction[] = [
  { type: TransactionType.INCOME, category: 'Salary', amount: '3200.00', at: 0.04, description: 'Monthly salary' },
  { type: TransactionType.EXPENSE, category: 'Housing', amount: '1150.00', at: 0.06, description: 'Rent' },
  { type: TransactionType.EXPENSE, category: 'Groceries', amount: '72.35', at: 0.1, description: 'Supermarket' },
  { type: TransactionType.EXPENSE, category: 'Utilities', amount: '86.40', at: 0.12, description: 'Electricity' },
  { type: TransactionType.EXPENSE, category: 'Eating out', amount: '18.60', at: 0.18, description: 'Lunch' },
  { type: TransactionType.EXPENSE, category: 'Subscriptions', amount: '11.99', at: 0.22, description: 'Music' },
  { type: TransactionType.EXPENSE, category: 'Transport', amount: '35.00', at: 0.3, description: 'Transit pass' },
  { type: TransactionType.EXPENSE, category: 'Groceries', amount: '54.10', at: 0.38, description: 'Farmers market' },
  { type: TransactionType.EXPENSE, category: 'Entertainment', amount: '24.00', at: 0.47, description: 'Cinema' },
  { type: TransactionType.INCOME, category: 'Freelance', amount: '480.00', at: 0.52, description: 'Website fixes' },
  { type: TransactionType.EXPENSE, category: 'Groceries', amount: '63.25', at: 0.66, description: 'Supermarket' },
  { type: TransactionType.EXPENSE, category: 'Eating out', amount: '42.80', at: 0.74, description: 'Dinner' },
  { type: TransactionType.EXPENSE, category: 'Health', amount: '15.20', at: 0.85, description: 'Pharmacy' },
];

export const SAMPLE_LIMIT = { category: 'Groceries', amount: '400.00' };

class TestFlightAccountEnv {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  TESTFLIGHT_USER_EMAIL!: string;

  @IsNewPassword()
  TESTFLIGHT_USER_PASSWORD!: string;
}

export function readTestFlightInput(env: NodeJS.ProcessEnv): TestFlightAccountInput {
  const input = Object.assign(new TestFlightAccountEnv(), {
    TESTFLIGHT_USER_EMAIL: env.TESTFLIGHT_USER_EMAIL,
    TESTFLIGHT_USER_PASSWORD: env.TESTFLIGHT_USER_PASSWORD,
  });
  const problems = validateSync(input).flatMap((error) => Object.values(error.constraints ?? {}));

  if (problems.length > 0) {
    throw new Error(`Invalid TestFlight account input:\n- ${problems.join('\n- ')}`);
  }

  return { email: input.TESTFLIGHT_USER_EMAIL, password: input.TESTFLIGHT_USER_PASSWORD };
}

// Writes nothing when the email is taken: an existing account is only
// checked, never reset, refilled or taken over.
export async function provisionTestFlightAccount(
  dataSource: DataSource,
  input: TestFlightAccountInput,
  now = new Date(),
): Promise<ProvisionOutcome> {
  const existing = await dataSource.getRepository(User).findOneBy({ email: input.email });

  if (existing) {
    await assertUsable(existing, input.password);
    return 'existing';
  }

  try {
    await runWriteTransaction(dataSource, (manager) => createAccount(manager, input, now));
    return 'created';
  } catch (error) {
    if (!isDuplicateKey(error, 'UQ_users_email')) {
      throw error;
    }
  }

  // a concurrent run created the account first
  const winner = await dataSource.getRepository(User).findOneByOrFail({ email: input.email });
  await assertUsable(winner, input.password);

  return 'existing';
}

async function assertUsable(user: User, password: string): Promise<void> {
  if (!(await bcrypt.compare(password, user.password))) {
    throw new Error(
      'An account with this email already exists and does not accept this password. Nothing was changed.',
    );
  }

  if (!user.email_verified) {
    throw new Error('An account with this email already exists but its email is not verified. Nothing was changed.');
  }
}

async function createAccount(manager: EntityManager, input: TestFlightAccountInput, now: Date): Promise<void> {
  const currency = await manager.getRepository(Currency).findOneBy({ code: TESTFLIGHT_CURRENCY_CODE });

  if (!currency) {
    throw new Error(
      `Currency ${TESTFLIGHT_CURRENCY_CODE} is missing: run the migrations and verify the reference data.`,
    );
  }

  const userRepository = manager.getRepository(User);
  const user = await userRepository.save(
    userRepository.create({
      name: TESTFLIGHT_USER_NAME,
      email: input.email,
      password: input.password,
      email_verified: 1,
    }),
  );

  const space = await createSpaceWithOwner(
    manager,
    { name: 'Personal', type: SpaceType.PERSONAL, currency_id: currency.id },
    user.id,
  );

  const walletRepository = manager.getRepository(Wallet);
  const wallet = await walletRepository.save(
    walletRepository.create({ space_id: space.id, wallet_name: 'Cash', design: AppColor.SLATE }),
  );

  await createDefaultCategories(manager, space.id);

  const categories = await manager.getRepository(Category).findBy({ space_id: space.id, is_system: 0 });
  const categoryId = (type: TransactionType, name: string): number => {
    const category = categories.find((found) => found.transaction_type === type && found.name === name);

    if (!category) {
      throw new Error(`The starter catalog has no ${type} category "${name}"`);
    }

    return category.id;
  };

  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const transactionRepository = manager.getRepository(Transaction);
  await transactionRepository.save(
    SAMPLE_TRANSACTIONS.map((sample) =>
      transactionRepository.create({
        wallet_id: wallet.id,
        category_id: categoryId(sample.type, sample.category),
        transaction_type: sample.type,
        amount: sample.amount,
        timestamp: new Date(monthStart + Math.floor((now.getTime() - monthStart) * sample.at)),
        description: sample.description,
      }),
    ),
  );

  const limitRepository = manager.getRepository(Limit);
  const limit = await limitRepository.save(
    limitRepository.create({
      space_id: space.id,
      name: null,
      limit_type: LimitType.CATEGORY,
      amount: SAMPLE_LIMIT.amount,
    }),
  );
  await limitRepository
    .createQueryBuilder()
    .relation('categories')
    .of(limit.id)
    .add(categoryId(TransactionType.EXPENSE, SAMPLE_LIMIT.category));
}
