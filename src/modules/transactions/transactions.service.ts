import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { UpdateTransactionDto } from './dto/update-transaction.dto';
import type { TransactionView, UpdateTransactionResult } from './dto/transaction-responses';
import { toTransactionView } from './transaction-view';
import {
  AMOUNT_NOT_POSITIVE,
  TIMESTAMP_IN_FUTURE,
  isNotInFuture,
  isPositiveAmount,
  normalizeDescription,
} from './transaction-rules';
import {
  assertCategoryActive,
  assertCategoryType,
  assertNotSystem,
  assertUserCategory,
  assertVersion,
  assertWalletActive,
  assertWalletInSpace,
} from './transaction-checks';
import { ApiException } from '@shared/api.exception';
import { assertFound, lockRows, moneyToNumber, parseMoney, runWriteTransaction, toDate } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
  type TransactionFilters,
} from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';

export interface WriteOptions {
  idempotencyKey?: string;
  // the version the client read; without it the write is unconditional
  expectedVersion?: number;
}

export interface CreateTransactionResult {
  transaction: TransactionView;
  wallet: WalletWithBalance;
  previous_balance: number;
}

type TransactionChanges = Partial<
  Pick<Transaction, 'wallet_id' | 'category_id' | 'transaction_type' | 'amount' | 'timestamp' | 'description'>
>;

@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly walletsService: WalletsService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly idempotencyService: IdempotencyService,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    userId: number,
    spaceId: number,
    createTransactionDto: CreateTransactionDto,
    options: WriteOptions = {},
  ): Promise<CreateTransactionResult> {
    const idempotency = {
      operation: 'transactions.create',
      key: options.idempotencyKey,
      payload: createTransactionDto,
    };

    return this.write(userId, spaceId, idempotency, async (manager) => {
      const [wallet] = await lockRows(manager, Wallet, [createTransactionDto.wallet_id], 'exclusive');
      assertWalletInSpace(wallet, spaceId);
      assertWalletActive(wallet);
      const [category] = await lockRows(manager, Category, [createTransactionDto.category_id], 'shared');
      assertUserCategory(category, spaceId);
      assertCategoryActive(category);
      assertCategoryType(category, createTransactionDto.transaction_type);

      // both balances are sums of history read under the wallet lock, before
      // and after the insert, not a computed difference
      const previousBalance = await this.getBalance(manager, wallet.id);
      const transactionRepository = manager.getRepository(Transaction);
      const saved = await transactionRepository.save(
        transactionRepository.create({
          wallet_id: wallet.id,
          category_id: category.id,
          transaction_type: createTransactionDto.transaction_type,
          amount: createTransactionDto.amount,
          timestamp: toDate(createTransactionDto.timestamp),
          description: normalizeDescription(createTransactionDto.description),
        }),
      );
      const balance = await this.getBalance(manager, wallet.id);
      const created = await this.transactionQueriesService.getOneInSpace(spaceId, saved.id, manager);
      assertFound(created, 'TRANSACTION_NOT_FOUND');

      return {
        transaction: toTransactionView(created),
        wallet: Object.assign(wallet, { balance: moneyToNumber(balance) }),
        previous_balance: moneyToNumber(previousBalance),
      };
    });
  }

  // Merges the request into the stored record and checks the result. Only
  // changed values are checked against the rules for new values, so an edit
  // keeps a deleted wallet, an archived category or a legacy value it does
  // not change. An edit that changes nothing writes nothing and keeps the
  // version.
  async update(
    userId: number,
    spaceId: number,
    transactionId: string,
    updateTransactionDto: UpdateTransactionDto,
    options: WriteOptions = {},
  ): Promise<UpdateTransactionResult> {
    const { expectedVersion, idempotencyKey } = options;

    if (expectedVersion === undefined) {
      throw new ApiException('TRANSACTION_VERSION_REQUIRED', HttpStatus.PRECONDITION_REQUIRED);
    }

    const idempotency = {
      operation: 'transactions.update',
      key: idempotencyKey,
      payload: { transactionId, expectedVersion, body: updateTransactionDto },
    };

    return this.write(userId, spaceId, idempotency, async (manager) => {
      const original = await this.lockTransaction(manager, spaceId, transactionId);
      assertNotSystem(original);
      assertVersion(original, expectedVersion);

      const changes = changedFields(original, updateTransactionDto);
      assertNewValues(changes);

      const walletIds = [original.wallet_id, ...(changes.wallet_id === undefined ? [] : [changes.wallet_id])];
      const wallets = await lockRows(manager, Wallet, walletIds, 'exclusive');

      if (changes.wallet_id !== undefined) {
        const target = wallets.find((wallet) => wallet.id === changes.wallet_id);
        assertWalletInSpace(target, spaceId);
        assertWalletActive(target);
      }

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

      if (Object.keys(changes).length > 0) {
        // the update query also bumps the @VersionColumn
        await manager
          .createQueryBuilder()
          .update(Transaction)
          .set(changes)
          .where('id = :id', { id: original.id })
          .execute();
      }

      const updated = await this.transactionQueriesService.getOneInSpace(spaceId, original.id, manager);
      assertFound(updated, 'TRANSACTION_NOT_FOUND');
      const balances = await this.transactionQueriesService.getBalances(walletIds, manager);

      return {
        transaction: toTransactionView(updated),
        wallets: walletIds.map((id) => ({
          id,
          balance: moneyToNumber(balances.get(id) ?? 0n),
          is_deleted: Boolean(wallets.find((wallet) => wallet.id === id)?.is_deleted),
        })),
      };
    });
  }

  // An archived category is a valid filter: its history is kept.
  async getAll(
    userId: number,
    spaceId: number,
    from: Date,
    to: Date,
    filters: TransactionFilters = {},
  ): Promise<TransactionView[]> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (filters.categoryId !== undefined) {
      await this.getUserCategory(spaceId, filters.categoryId);
    }

    if (filters.walletId !== undefined) {
      await this.getActiveWallet(spaceId, filters.walletId);
    }

    const transactions = await this.transactionQueriesService.getForAllWallets(spaceId, from, to, filters);

    return transactions.map(toTransactionView);
  }

  async getLatest(userId: number, spaceId: number): Promise<TransactionView | null> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getLatest(spaceId);

    return transaction ? toTransactionView(transaction) : null;
  }

  async getById(userId: number, spaceId: number, transactionId: string): Promise<TransactionView> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getOneInSpace(spaceId, transactionId);
    assertFound(transaction, 'TRANSACTION_NOT_FOUND');

    return toTransactionView(transaction);
  }

  async remove(userId: number, spaceId: number, transactionId: string, options: WriteOptions = {}): Promise<void> {
    const { expectedVersion, idempotencyKey } = options;
    const idempotency = {
      operation: 'transactions.delete',
      key: idempotencyKey,
      payload: { transactionId, expectedVersion: expectedVersion ?? null },
    };

    await this.write(userId, spaceId, idempotency, async (manager) => {
      const transaction = await this.lockTransaction(manager, spaceId, transactionId);
      assertNotSystem(transaction);
      assertVersion(transaction, expectedVersion);
      // its balance changes: writes to one wallet queue on its row
      await lockRows(manager, Wallet, [transaction.wallet_id], 'exclusive');

      await manager.getRepository(Transaction).delete(transaction.id);

      return true;
    });
  }

  private async getBalance(manager: EntityManager, walletId: number): Promise<bigint> {
    const balances = await this.transactionQueriesService.getBalances([walletId], manager);

    return balances.get(walletId) ?? 0n;
  }

  private async lockTransaction(
    manager: EntityManager,
    spaceId: number,
    transactionId: string,
  ): Promise<LoadedTransaction> {
    const [locked] = await lockRows(manager, Transaction, [transactionId], 'exclusive');
    const transaction = locked
      ? await this.transactionQueriesService.getOneInSpace(spaceId, transactionId, manager)
      : null;
    assertFound(transaction, 'TRANSACTION_NOT_FOUND');

    return transaction;
  }

  // One DB transaction per write, locks taken in one order across the app:
  // the acting member's row, the space row, the idempotency key, the
  // transaction row, wallet rows by ascending id, category rows. Access is
  // checked under these locks, so a membership removed or a category archived
  // meanwhile is seen, and a repeat with the same key gets the stored result.
  private async write<T>(
    userId: number,
    spaceId: number,
    idempotency: { operation: string; key: string | undefined; payload: unknown },
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const { key } = idempotency;
    const result = await runWriteTransaction(this.dataSource, async (manager) => {
      await this.spaceAccessService.lockMembership(spaceId, userId, manager);
      await this.spaceAccessService.lockSpace(spaceId, manager, 'shared');

      return key === undefined
        ? work(manager)
        : this.idempotencyService.run(manager, { ...idempotency, key, userId, spaceId }, () => work(manager));
    });

    if (key !== undefined) {
      await this.idempotencyService.purgeExpired();
    }

    return result;
  }

  // a list filter: any category of the space but the system one, archived included
  private async getUserCategory(spaceId: number, categoryId: number): Promise<Category> {
    const category = await this.categoriesService.getOne(categoryId);
    assertUserCategory(category, spaceId);

    return category;
  }

  // a list filter: an active wallet of the space; a deleted one is forbidden
  private async getActiveWallet(spaceId: number, walletId: number): Promise<Wallet> {
    const wallet = await this.walletsService.getOne(walletId);
    assertWalletInSpace(wallet, spaceId);

    if (wallet.is_deleted) {
      throw new ApiException('FORBIDDEN_WALLET', HttpStatus.FORBIDDEN);
    }

    return wallet;
  }
}

// Equality is by value: a field equal to the stored one is not a change.
function changedFields(original: Transaction, dto: UpdateTransactionDto): TransactionChanges {
  const changes: TransactionChanges = {};

  if (dto.wallet_id !== undefined && dto.wallet_id !== original.wallet_id) {
    changes.wallet_id = dto.wallet_id;
  }

  if (dto.category_id !== undefined && dto.category_id !== original.category_id) {
    changes.category_id = dto.category_id;
  }

  if (dto.transaction_type !== undefined && dto.transaction_type !== original.transaction_type) {
    changes.transaction_type = dto.transaction_type;
  }

  if (dto.amount !== undefined && parseMoney(dto.amount) !== parseMoney(original.amount)) {
    changes.amount = dto.amount;
  }

  if (dto.timestamp !== undefined && toDate(dto.timestamp).getTime() !== original.timestamp.getTime()) {
    changes.timestamp = toDate(dto.timestamp);
  }

  const description = normalizeDescription(dto.description);

  if (dto.description !== undefined && description !== normalizeDescription(original.description)) {
    changes.description = description;
  }

  return changes;
}

function assertNewValues(changes: TransactionChanges): void {
  if (changes.amount !== undefined && !isPositiveAmount(changes.amount)) {
    throw new BadRequestException([{ field: 'amount', error: AMOUNT_NOT_POSITIVE }]);
  }

  if (changes.timestamp !== undefined && !isNotInFuture(changes.timestamp.toISOString())) {
    throw new BadRequestException([{ field: 'timestamp', error: TIMESTAMP_IN_FUTURE }]);
  }
}
