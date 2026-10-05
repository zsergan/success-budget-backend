import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { TransactionView } from './dto/transaction-responses';
import { toTransactionView } from './transaction-view';
import { normalizeDescription } from './transaction-rules';
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
import { assertFound, lockRows, moneyToNumber, runWriteTransaction, toDate } from '@shared/utils';
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
