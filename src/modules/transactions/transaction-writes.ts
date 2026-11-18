import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { TRANSACTION_OPERATION_SCOPE, TransactionOperation } from '@entities/transaction-operation.entity';
import { Wallet } from '@entities/wallet.entity';
import { Category } from '@entities/category.entity';
import type { SpaceMember } from '@entities/space-member.entity';
import { ApiException } from '@shared/api.exception';
import type { TransactionType } from '@shared/enums';
import { assertFound, isDuplicateKey, lockRows, runWriteTransaction } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
} from '@modules/transaction-queries/transaction-queries.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import {
  assertCategoryActive,
  assertCategoryType,
  assertNotSystem,
  assertUserCategory,
  assertVersion,
} from './transaction-checks';
import type { TransactionChanges } from './transaction-changes';

export interface WriteOptions {
  idempotencyKey?: string;
  // the version the client read (If-Match); required by update and delete
  expectedVersion?: number;
}

// The operation name scopes the key: v1 and v2 keys never answer each other.
export interface IdempotentWrite {
  operation: string;
  key: string | undefined;
  payload: unknown;
}

export interface WriteAccess {
  // the locked memberships of the actor and, when asked for, the assignee;
  // a user missing here is not a member of the space
  members: ReadonlyMap<number, SpaceMember>;
}

export function requireVersion({ expectedVersion }: WriteOptions): number {
  if (expectedVersion === undefined) {
    throw new ApiException('TRANSACTION_VERSION_REQUIRED', HttpStatus.PRECONDITION_REQUIRED);
  }

  return expectedVersion;
}

// The write unit and the steps that v1 and v2 transaction writes share.
@Injectable()
export class TransactionWrites {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly idempotencyService: IdempotencyService,
    private readonly dataSource: DataSource,
  ) {}

  // One DB transaction per write, locks taken in one order across the app:
  // the acting member's row, with the assignee's (shared, ascending id), the
  // space row, the idempotency key, the transaction row, wallet rows by
  // ascending id, category rows, the operation row. Access is checked under
  // these locks, so a membership removed or a category archived meanwhile is
  // seen, and a repeat with the same key gets the stored result.
  run<T>(
    userId: number,
    spaceId: number,
    idempotency: IdempotentWrite,
    work: (manager: EntityManager, access: WriteAccess) => Promise<T>,
    assigneeUserId?: number,
  ): Promise<T> {
    const { key } = idempotency;

    return runWriteTransaction(this.dataSource, async (manager) => {
      const members =
        assigneeUserId === undefined || assigneeUserId === userId
          ? new Map([[userId, await this.spaceAccessService.lockMembership(spaceId, userId, manager)]])
          : await this.spaceAccessService.lockMemberships(spaceId, userId, [assigneeUserId], manager);
      await this.spaceAccessService.lockSpace(spaceId, manager, 'shared');

      const access: WriteAccess = { members };

      return key === undefined
        ? work(manager, access)
        : this.idempotencyService.run(manager, { ...idempotency, key, userId, spaceId }, () => work(manager, access));
    });
  }

  async assertOperationUnused(manager: EntityManager, spaceId: number, operationId: string): Promise<void> {
    const used = await manager
      .getRepository(TransactionOperation)
      .exists({ where: { space_id: spaceId, operation_id: operationId } });

    if (used) {
      throw new ApiException('TRANSACTION_OPERATION_EXISTS', HttpStatus.CONFLICT);
    }
  }

  // The unique key settles a race the check above cannot see: a concurrent
  // create with the same id, through either API version, makes this insert
  // wait for it, then fail.
  async recordOperation(
    manager: EntityManager,
    spaceId: number,
    operationId: string,
    transactionId: string,
  ): Promise<void> {
    try {
      await manager.getRepository(TransactionOperation).insert({
        space_id: spaceId,
        operation_id: operationId,
        transaction_id: transactionId,
        created_at: new Date(),
        deleted_at: null,
      });
    } catch (error) {
      if (isDuplicateKey(error, TRANSACTION_OPERATION_SCOPE)) {
        throw new ApiException('TRANSACTION_OPERATION_EXISTS', HttpStatus.CONFLICT);
      }

      throw error;
    }
  }

  async lockTransaction(manager: EntityManager, spaceId: number, transactionId: string): Promise<LoadedTransaction> {
    const [locked] = await lockRows(manager, Transaction, [transactionId], 'exclusive');
    const transaction = locked
      ? await this.transactionQueriesService.getOneInSpace(spaceId, transactionId, manager)
      : null;
    assertFound(transaction, 'TRANSACTION_NOT_FOUND');

    return transaction;
  }

  // the category of a new record: of the space, not the system one, active, of its type
  async lockNewCategory(
    manager: EntityManager,
    spaceId: number,
    categoryId: number,
    transactionType: TransactionType,
  ): Promise<Category> {
    const [category] = await lockRows(manager, Category, [categoryId], 'shared');
    assertUserCategory(category, spaceId);
    assertCategoryActive(category);
    assertCategoryType(category, transactionType);

    return category;
  }

  // Only a changed category must be active; a changed type or category must
  // agree with the other, so an edit keeps an archived category or a legacy
  // mismatch it does not touch.
  async checkChangedCategory(
    manager: EntityManager,
    spaceId: number,
    original: LoadedTransaction,
    changes: TransactionChanges,
  ): Promise<void> {
    let category: Category = original.category;

    if (changes.category_id !== undefined) {
      const [target] = await lockRows(manager, Category, [changes.category_id], 'shared');
      assertUserCategory(target, spaceId);
      assertCategoryActive(target);
      category = target;
    }

    if (changes.category_id !== undefined || changes.transaction_type !== undefined) {
      assertCategoryType(category, changes.transaction_type ?? original.transaction_type);
    }
  }

  // An edit that changes nothing writes nothing and keeps the version.
  async applyChanges(manager: EntityManager, transactionId: string, changes: TransactionChanges): Promise<void> {
    if (Object.keys(changes).length > 0) {
      // the update query also bumps the @VersionColumn
      await manager
        .createQueryBuilder()
        .update(Transaction)
        .set(changes)
        .where('id = :id', { id: transactionId })
        .execute();
    }
  }

  // Also the undo of a create. Deleting a record of a deleted wallet changes
  // history, statistics and limits, but no active wallet's balance.
  async deleteRecord(
    manager: EntityManager,
    spaceId: number,
    transactionId: string,
    expectedVersion: number,
  ): Promise<void> {
    const transaction = await this.lockTransaction(manager, spaceId, transactionId);
    assertNotSystem(transaction);
    assertVersion(transaction, expectedVersion);
    // its balance changes: writes to one wallet queue on its row
    await lockRows(manager, Wallet, [transaction.wallet_id], 'exclusive');

    await manager.getRepository(Transaction).delete(transaction.id);
    await manager
      .getRepository(TransactionOperation)
      .update({ transaction_id: transaction.id }, { deleted_at: new Date() });
  }

  // What became of a create sent with this client_operation_id, through
  // either API version; null when none committed in the space.
  async readOperation(
    manager: EntityManager,
    spaceId: number,
    operationId: string,
  ): Promise<{ operation: TransactionOperation; transaction: LoadedTransaction | null } | null> {
    const operation = await manager
      .getRepository(TransactionOperation)
      .findOne({ where: { space_id: spaceId, operation_id: operationId.toLowerCase() } });

    if (!operation) {
      return null;
    }

    const transaction = await this.transactionQueriesService.getOneInSpace(spaceId, operation.transaction_id, manager);

    return { operation, transaction };
  }
}
