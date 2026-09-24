import { Category } from '@entities/category.entity';
import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { Currency } from '@entities/currency.entity';
import { Limit } from '@entities/limit.entity';
import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { Transaction } from '@entities/transaction.entity';
import { User } from '@entities/user.entity';
import { Wallet } from '@entities/wallet.entity';
import {
  AppColor,
  CategoryIcon,
  ConfirmationCodeSendStatus,
  ConfirmationType,
  LimitType,
  SpaceRole,
  SpaceType,
  TransactionType,
} from '@shared/enums';

// Entity instances shaped like a MySQL read: DECIMAL amounts as strings,
// nullable columns as null, relations absent unless passed in.
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

export function buildCurrency(overrides: Partial<Currency> = {}): Currency {
  return Object.assign(new Currency(), { id: 1, code: 'USD', name: 'US Dollar' }, overrides);
}

export function buildUser(overrides: Partial<User> = {}): User {
  return Object.assign(
    new User(),
    {
      id: 1,
      email: 'user@example.com',
      name: 'User',
      password: 'hashed-password',
      email_verified: 1,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildSpace(overrides: Partial<Space> = {}): Space {
  return Object.assign(
    new Space(),
    {
      id: 1,
      name: 'Personal',
      type: SpaceType.PERSONAL,
      currency_id: 1,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildSpaceMember(overrides: Partial<SpaceMember> = {}): SpaceMember {
  return Object.assign(
    new SpaceMember(),
    { id: 1, space_id: 1, user_id: 1, role: SpaceRole.OWNER, created_at: CREATED_AT },
    overrides,
  );
}

export function buildSpaceInvite(overrides: Partial<SpaceInvite> = {}): SpaceInvite {
  return Object.assign(
    new SpaceInvite(),
    {
      id: 1,
      space_id: 1,
      email: 'invitee@example.com',
      code: '123456',
      role: SpaceRole.MEMBER,
      expires_at: new Date(CREATED_AT.getTime() + 7 * 24 * 60 * 60 * 1000),
      accepted_at: null,
      revoked_at: null,
      created_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildWallet(overrides: Partial<Wallet> = {}): Wallet {
  return Object.assign(
    new Wallet(),
    {
      id: 1,
      space_id: 1,
      wallet_name: 'Cash',
      design: AppColor.SLATE,
      is_deleted: 0,
      deleted_at: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildCategory(overrides: Partial<Category> = {}): Category {
  return Object.assign(
    new Category(),
    {
      id: 1,
      space_id: 1,
      name: 'Grocery',
      transaction_type: TransactionType.EXPENSE,
      icon: CategoryIcon.GROCERY,
      color: AppColor.EVERGREEN,
      is_active: 1,
      archived_at: null,
      sort: 201,
      is_system: 0,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildLimit(overrides: Partial<Limit> = {}): Limit {
  return Object.assign(
    new Limit(),
    {
      id: 1,
      space_id: 1,
      name: null,
      limit_type: LimitType.CATEGORY,
      amount: '100.00',
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    },
    overrides,
  );
}

export function buildTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return Object.assign(
    new Transaction(),
    {
      id: '1',
      wallet_id: 1,
      category_id: 1,
      transaction_type: TransactionType.EXPENSE,
      amount: '10.00',
      timestamp: CREATED_AT,
      description: null,
    },
    overrides,
  );
}

export function buildConfirmationCode(overrides: Partial<ConfirmationCode> = {}): ConfirmationCode {
  return Object.assign(
    new ConfirmationCode(),
    {
      id: 1,
      user_id: 1,
      confirmation_code: '123456',
      attempts: 0,
      confirmation_type: ConfirmationType.EMAIL,
      created_at: CREATED_AT,
      expired_at: new Date(CREATED_AT.getTime() + 10 * 60 * 1000),
      last_sent_at: null,
      last_attempted_at: null,
      send_status: ConfirmationCodeSendStatus.SENT,
      send_attempt_id: 1,
    },
    overrides,
  );
}
