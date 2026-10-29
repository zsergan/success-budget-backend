import { AppColor, CategoryIcon, TransactionType } from './enums';
import { CreateCategoryDto } from '@modules/categories/dto/create-category.dto';

export const MAX_CONFIRMATION_CODE_ATTEMPTS = 5;

// Minimum time between confirmation-code emails for the same code, counted
// from the last send *attempt* (successful or not) - this also throttles
// retries against a struggling SMTP server, not just deliberate resends.
export const CONFIRMATION_CODE_RESEND_COOLDOWN_MS = 1000 * 60; // 1 minute

export const CONFIRMATION_CODE_TTL_MS = 1000 * 60 * 10; // 10 minutes

export const PASSWORD_HASH_ROUNDS = 10;

export const NEW_PASSWORD_MIN_LENGTH = 8;

// bcrypt ignores everything past the first 72 bytes
export const NEW_PASSWORD_MAX_BYTES = 72;

// temporary defaults, not a considered business limit - revisit later
export const SPACE_LIMITS = {
  MAX_MEMBERS_PER_SPACE: 20,
  MAX_PENDING_INVITES_PER_SPACE: 10,
};

export const SPACE_INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// device clocks drift; a slightly early server must not reject the client's now
export const CLOCK_SKEW_MS = 60_000;

export const IDEMPOTENCY_KEY_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export const IDEMPOTENCY_KEY_PURGE_INTERVAL_MS = 1000 * 60 * 10; // 10 minutes

// listed in display order: one save() keeps it as id order
export const DEFAULT_CATEGORIES: CreateCategoryDto[] = [
  { name: 'Salary', transaction_type: TransactionType.INCOME, icon: CategoryIcon.SALARY, color: AppColor.EVERGREEN },
  { name: 'Freelance', transaction_type: TransactionType.INCOME, icon: CategoryIcon.FREELANCE, color: AppColor.INDIGO },
  { name: 'Gifts', transaction_type: TransactionType.INCOME, icon: CategoryIcon.GIFTS, color: AppColor.CLAY },
  { name: 'Other income', transaction_type: TransactionType.INCOME, icon: CategoryIcon.OTHER, color: AppColor.SLATE },
  {
    name: 'Groceries',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.GROCERY,
    color: AppColor.EVERGREEN,
  },
  {
    name: 'Eating out',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.RESTAURANT,
    color: AppColor.CLAY,
  },
  { name: 'Housing', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.HOUSING, color: AppColor.SLATE },
  { name: 'Utilities', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.UTILITIES, color: AppColor.AMBER },
  {
    name: 'Transport',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.TRANSPORT,
    color: AppColor.INDIGO,
  },
  { name: 'Car', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.CAR, color: AppColor.SLATE },
  { name: 'Health', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.HEALTH, color: AppColor.CLAY },
  {
    name: 'Personal care',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.BEAUTY,
    color: AppColor.AMBER,
  },
  { name: 'Clothes', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.CLOTHES, color: AppColor.PLUM },
  {
    name: 'Home goods',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.HOME_GOODS,
    color: AppColor.EVERGREEN,
  },
  {
    name: 'Entertainment',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.ENTERTAINMENT,
    color: AppColor.AMBER,
  },
  {
    name: 'Subscriptions',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.SUBSCRIPTIONS,
    color: AppColor.INDIGO,
  },
  { name: 'Education', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.EDUCATION, color: AppColor.SLATE },
  { name: 'Travel', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.TRAVEL, color: AppColor.INDIGO },
  { name: 'Gifts', transaction_type: TransactionType.EXPENSE, icon: CategoryIcon.GIFTS, color: AppColor.CLAY },
  {
    name: 'Other expenses',
    transaction_type: TransactionType.EXPENSE,
    icon: CategoryIcon.OTHER,
    color: AppColor.SLATE,
  },
];

// separate from DEFAULT_CATEGORIES (typed CreateCategoryDto[], which has
// no is_system field) - seeded once per space, never client-creatable
export const INITIAL_BALANCE_CATEGORY = {
  name: 'Initial balance',
  transaction_type: TransactionType.INCOME,
  icon: CategoryIcon.SAVINGS,
  color: AppColor.SLATE,
  is_system: 1,
};
