import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { TransactionView } from './dto/transaction-responses';
import { toTransactionView } from './transaction-view';
import { TransactionType } from '@shared/enums';
import { ApiException } from '@shared/api.exception';
import {
  assertBelongsToSpace,
  assertFound,
  lockRows,
  moneyToNumber,
  parseMoney,
  runWriteTransaction,
  toDate,
} from '@shared/utils';
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
  transaction: Transaction;
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
      assertActiveWallet(wallet, spaceId);
      const [category] = await lockRows(manager, Category, [createTransactionDto.category_id], 'shared');
      assertUserCategory(category, spaceId);

      const balances = await this.transactionQueriesService.getBalances([wallet.id], manager);
      const previousBalance = balances.get(wallet.id) ?? 0n;
      const amount = parseMoney(createTransactionDto.amount);
      const balanceChange = createTransactionDto.transaction_type === TransactionType.INCOME ? amount : -amount;
      // converted before saving, so a failed conversion leaves nothing written
      const previousBalanceValue = moneyToNumber(previousBalance);
      const balanceValue = moneyToNumber(previousBalance + balanceChange);

      const transactionRepository = manager.getRepository(Transaction);
      const savedTransaction = await transactionRepository.save(
        transactionRepository.create({
          wallet_id: createTransactionDto.wallet_id,
          category_id: createTransactionDto.category_id,
          transaction_type: createTransactionDto.transaction_type,
          amount: createTransactionDto.amount,
          timestamp: toDate(createTransactionDto.timestamp),
          description: createTransactionDto.description ?? null,
        }),
      );

      return {
        transaction: savedTransaction,
        wallet: Object.assign(wallet, { balance: balanceValue }),
        previous_balance: previousBalanceValue,
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

      if (transaction.category.is_system) {
        throw new ApiException('TRANSACTION_IS_SYSTEM', HttpStatus.BAD_REQUEST);
      }

      assertVersion(transaction, expectedVersion);

      await manager.getRepository(Transaction).delete(transaction.id);

      return true;
    });
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

  private async getActiveWallet(spaceId: number, walletId: number): Promise<Wallet> {
    const wallet = await this.walletsService.getOne(walletId);
    assertActiveWallet(wallet, spaceId);

    return wallet;
  }

  private async getUserCategory(spaceId: number, categoryId: number): Promise<Category> {
    const category = await this.categoriesService.getOne(categoryId);
    assertUserCategory(category, spaceId);

    return category;
  }
}

function assertActiveWallet(wallet: Wallet | null | undefined, spaceId: number): asserts wallet is Wallet {
  assertBelongsToSpace(wallet, spaceId, 'FORBIDDEN_WALLET');

  if (wallet.is_deleted) {
    throw new ApiException('FORBIDDEN_WALLET', HttpStatus.FORBIDDEN);
  }
}

function assertVersion(transaction: Transaction, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && transaction.version !== expectedVersion) {
    throw new ApiException('TRANSACTION_VERSION_CONFLICT', HttpStatus.CONFLICT);
  }
}

// any category of the space but the system one, archived included
function assertUserCategory(category: Category | null | undefined, spaceId: number): asserts category is Category {
  assertBelongsToSpace(category, spaceId, 'FORBIDDEN_CATEGORY');

  if (category.is_system) {
    throw new ApiException('FORBIDDEN_CATEGORY', HttpStatus.FORBIDDEN);
  }
}
