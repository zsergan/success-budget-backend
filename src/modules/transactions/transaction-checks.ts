import { HttpStatus } from '@nestjs/common';

import type { Category } from '@entities/category.entity';
import type { Wallet } from '@entities/wallet.entity';
import type { Transaction } from '@entities/transaction.entity';
import type { TransactionType } from '@shared/enums';
import { ApiException } from '@shared/api.exception';
import { assertBelongsToSpace } from '@shared/utils';

// Building blocks shared by create and update. Create applies all of them;
// update applies each only to a value that changes, which is what lets an
// edit keep a deleted wallet or an archived category it already had.

export function assertWalletInSpace(wallet: Wallet | null | undefined, spaceId: number): asserts wallet is Wallet {
  assertBelongsToSpace(wallet, spaceId, 'FORBIDDEN_WALLET');
}

export function assertWalletActive(wallet: Wallet): void {
  if (wallet.is_deleted) {
    throw new ApiException('WALLET_DELETED', HttpStatus.BAD_REQUEST);
  }
}

// any category of the space but the system one
export function assertUserCategory(
  category: Category | null | undefined,
  spaceId: number,
): asserts category is Category {
  assertBelongsToSpace(category, spaceId, 'FORBIDDEN_CATEGORY');

  if (category.is_system) {
    throw new ApiException('FORBIDDEN_CATEGORY', HttpStatus.FORBIDDEN);
  }
}

export function assertCategoryActive(category: Category): void {
  if (!category.is_active) {
    throw new ApiException('CATEGORY_ARCHIVED', HttpStatus.BAD_REQUEST);
  }
}

export function assertCategoryType(category: Category, transactionType: TransactionType): void {
  if (category.transaction_type !== transactionType) {
    throw new ApiException('CATEGORY_TYPE_MISMATCH', HttpStatus.BAD_REQUEST);
  }
}

export function assertVersion(transaction: Transaction, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && transaction.version !== expectedVersion) {
    throw new ApiException('TRANSACTION_VERSION_CONFLICT', HttpStatus.CONFLICT);
  }
}

export function assertNotSystem(transaction: Transaction & { category: Category }): void {
  if (transaction.category.is_system) {
    throw new ApiException('TRANSACTION_IS_SYSTEM', HttpStatus.BAD_REQUEST);
  }
}
