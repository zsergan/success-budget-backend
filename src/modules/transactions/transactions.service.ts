import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { UpdateTransactionDto } from './dto/update-transaction.dto';
import type { TransactionFeedQueryDto } from './dto/transaction-feed-query.dto';
import type {
  TransactionCount,
  TransactionFeed,
  TransactionOperationView,
  TransactionView,
  UpdateTransactionResult,
} from './dto/transaction-responses';
import { toTransactionView } from './transaction-view';
import { normalizeDescription } from './transaction-rules';
import {
  assertNotSystem,
  assertUserCategory,
  assertVersion,
  assertWalletActive,
  assertWalletInSpace,
} from './transaction-checks';
import { assertNewValues, changedFields } from './transaction-changes';
import { TransactionWrites, type WriteOptions, requireVersion } from './transaction-writes';
import { TransactionFeedReader } from './transaction-feed-reader';
import { ApiException } from '@shared/api.exception';
import { TransactionOperationStatus } from '@shared/enums';
import { SPACE_ASSIGNMENT, recordedAuthor } from '@shared/transaction-ownership';
import { assertFound, lockRows, moneyToNumber, readSnapshot, resolveTimeZone, toDate } from '@shared/utils';
import {
  TransactionQueriesService,
  type TransactionFilters,
  type TransactionSelection,
} from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

export type { WriteOptions } from './transaction-writes';

export interface CreateTransactionResult {
  transaction: TransactionView;
  wallet: WalletWithBalance;
  previous_balance: number;
}

function toFeedSelection(spaceId: number, query: TransactionFeedQueryDto): TransactionSelection {
  return {
    spaceId,
    from: toDate(query.from),
    to: toDate(query.to),
    filters: {
      transactionType: query.transaction_type,
      kind: query.kind,
      categoryId: query.category_id,
      walletId: query.wallet_id,
      search: query.q,
      searchesWallets: true,
    },
  };
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly walletsService: WalletsService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly writes: TransactionWrites,
    private readonly feedReader: TransactionFeedReader,
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

    const operationId = createTransactionDto.client_operation_id?.toLowerCase();

    return this.writes.run(userId, spaceId, idempotency, async (manager) => {
      // before the domain checks: a create that already happened is reported
      // as such even if its wallet or category has changed since
      if (operationId !== undefined) {
        await this.writes.assertOperationUnused(manager, spaceId, operationId);
      }

      const [wallet] = await lockRows(manager, Wallet, [createTransactionDto.wallet_id], 'exclusive');
      assertWalletInSpace(wallet, spaceId);
      assertWalletActive(wallet);
      const category = await this.writes.lockNewCategory(
        manager,
        spaceId,
        createTransactionDto.category_id,
        createTransactionDto.transaction_type,
      );

      // both balances are sums of history read under the wallet lock, before
      // and after the insert, not a computed difference
      const previousBalance = await this.getBalance(manager, wallet.id);
      const transactionRepository = manager.getRepository(Transaction);
      const saved = await transactionRepository.save(
        transactionRepository.create({
          space_id: spaceId,
          wallet_id: wallet.id,
          ...recordedAuthor(userId),
          ...SPACE_ASSIGNMENT,
          category_id: category.id,
          transaction_type: createTransactionDto.transaction_type,
          amount: createTransactionDto.amount,
          timestamp: toDate(createTransactionDto.timestamp),
          description: normalizeDescription(createTransactionDto.description),
        }),
      );

      if (operationId !== undefined) {
        await this.writes.recordOperation(manager, spaceId, operationId, saved.id);
      }

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
    const { idempotencyKey } = options;
    const expectedVersion = requireVersion(options);
    const idempotency = {
      operation: 'transactions.update',
      key: idempotencyKey,
      payload: { transactionId, expectedVersion, body: updateTransactionDto },
    };

    return this.writes.run(userId, spaceId, idempotency, async (manager) => {
      const original = await this.writes.lockTransaction(manager, spaceId, transactionId);
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

      await this.writes.checkChangedCategory(manager, spaceId, original, changes);
      await this.writes.applyChanges(manager, original.id, changes);

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

  // the summary.count of the feed for the same query, initial balances included
  async count(
    userId: number,
    spaceId: number,
    from: Date,
    to: Date,
    filters: TransactionFilters = {},
  ): Promise<TransactionCount> {
    await this.checkHistoryQuery(userId, spaceId, from, to, filters);

    return {
      count: await this.transactionQueriesService.countSelection({
        spaceId,
        from,
        to,
        filters: { ...filters, searchesWallets: true },
      }),
    };
  }

  async getFeed(userId: number, spaceId: number, query: TransactionFeedQueryDto): Promise<TransactionFeed> {
    const selection = toFeedSelection(spaceId, query);

    return this.feedReader.read(
      {
        selection,
        timeZone: resolveTimeZone(query.time_zone)!,
        limit: query.limit,
        cursor: query.cursor,
        aroundId: query.around_id,
        version: 1,
      },
      () => this.checkHistoryQuery(userId, spaceId, selection.from, selection.to, selection.filters!),
      async (items) => items.map(toTransactionView),
    );
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

  // Also the undo of a create: the client deletes the record it created, with
  // the version from the POST result, so a record another member edited since
  // is refused instead of deleted. Deleting a record of a deleted wallet
  // changes history, statistics and limits, but no active wallet's balance.
  async remove(userId: number, spaceId: number, transactionId: string, options: WriteOptions = {}): Promise<void> {
    const { idempotencyKey } = options;
    const expectedVersion = requireVersion(options);
    const idempotency = {
      operation: 'transactions.delete',
      key: idempotencyKey,
      payload: { transactionId, expectedVersion },
    };

    await this.writes.run(userId, spaceId, idempotency, async (manager) => {
      await this.writes.deleteRecord(manager, spaceId, transactionId, expectedVersion);

      return true;
    });
  }

  // What became of a create sent with this client_operation_id, for as long
  // as the space exists. Not found means the create never committed.
  async getOperation(userId: number, spaceId: number, operationId: string): Promise<TransactionOperationView> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (!isUUID(operationId)) {
      throw new ApiException('TRANSACTION_OPERATION_NOT_FOUND', HttpStatus.NOT_FOUND);
    }

    return readSnapshot(this.dataSource, async (manager) => {
      const found = await this.writes.readOperation(manager, spaceId, operationId);

      if (!found) {
        throw new ApiException('TRANSACTION_OPERATION_NOT_FOUND', HttpStatus.NOT_FOUND);
      }

      const { operation, transaction } = found;

      return {
        operation_id: operation.operation_id,
        status: transaction ? TransactionOperationStatus.APPLIED : TransactionOperationStatus.DELETED,
        transaction_id: operation.transaction_id,
        created_at: operation.created_at,
        deleted_at: transaction ? null : operation.deleted_at,
        transaction: transaction && toTransactionView(transaction),
      };
    });
  }

  // An archived category is a valid filter: its history is kept.
  private async checkHistoryQuery(
    userId: number,
    spaceId: number,
    from: Date,
    to: Date,
    filters: TransactionFilters,
  ): Promise<void> {
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException([{ field: 'from', error: 'from must not be after to' }]);
    }

    await this.spaceAccessService.assertMembership(spaceId, userId);

    if (filters.categoryId !== undefined) {
      await this.getUserCategory(spaceId, filters.categoryId);
    }

    if (filters.walletId !== undefined) {
      await this.getActiveWallet(spaceId, filters.walletId);
    }
  }

  private async getBalance(manager: EntityManager, walletId: number): Promise<bigint> {
    const balances = await this.transactionQueriesService.getBalances([walletId], manager);

    return balances.get(walletId) ?? 0n;
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
