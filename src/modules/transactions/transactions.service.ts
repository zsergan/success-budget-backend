import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import type { Category } from '@entities/category.entity';
import type { Wallet, WalletWithBalance } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertBelongsToSpace, moneyToNumber, parseMoney, toDate } from '@shared/utils';
import {
  TransactionQueriesService,
  type LoadedTransaction,
  type TransactionFilters,
} from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

export interface CreateTransactionResult {
  transaction: Transaction;
  wallet: WalletWithBalance;
  previous_balance: number;
}

// GET reads: the wallet is always joined, but hidden (null) once soft-deleted
export type TransactionView = Omit<LoadedTransaction, 'wallet'> & { wallet: Wallet | null };

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly transactionQueriesService: TransactionQueriesService,
    private readonly walletsService: WalletsService,
    private readonly categoriesService: CategoriesService,
    private readonly spaceAccessService: SpaceAccessService,
  ) {}

  async create(
    userId: number,
    spaceId: number,
    createTransactionDto: CreateTransactionDto,
  ): Promise<CreateTransactionResult> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const wallet = await this.getActiveWallet(spaceId, createTransactionDto.wallet_id);
    await this.getUserCategory(spaceId, createTransactionDto.category_id);

    const balances = await this.transactionQueriesService.getBalances([wallet.id]);
    const previousBalance = balances.get(wallet.id) ?? 0n;
    const amount = parseMoney(createTransactionDto.amount);
    const balanceChange = createTransactionDto.transaction_type === TransactionType.INCOME ? amount : -amount;
    // converted before saving, so a failed conversion leaves nothing written
    const previousBalanceValue = moneyToNumber(previousBalance);
    const balanceValue = moneyToNumber(previousBalance + balanceChange);

    const transaction = this.transactionRepository.create({
      wallet_id: createTransactionDto.wallet_id,
      category_id: createTransactionDto.category_id,
      transaction_type: createTransactionDto.transaction_type,
      amount: createTransactionDto.amount,
      timestamp: toDate(createTransactionDto.timestamp),
      description: createTransactionDto.description ?? null,
    });
    const savedTransaction = await this.transactionRepository.save(transaction);

    return {
      transaction: savedTransaction,
      wallet: Object.assign(wallet, { balance: balanceValue }),
      previous_balance: previousBalanceValue,
    };
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

    return transactions.map((transaction) => this.toView(transaction));
  }

  async getLatest(userId: number, spaceId: number): Promise<TransactionView | null> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getLatest(spaceId);

    return transaction ? this.toView(transaction) : null;
  }

  async remove(userId: number, spaceId: number, transactionId: string): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getOneWithWallet(transactionId);
    assertBelongsToSpace(transaction?.wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    await this.transactionRepository.delete(transaction.id);
  }

  private async getActiveWallet(spaceId: number, walletId: number): Promise<Wallet> {
    const wallet = await this.walletsService.getOne(walletId);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    if (wallet.is_deleted) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    return wallet;
  }

  // any category of the space but the system one, archived included
  private async getUserCategory(spaceId: number, categoryId: number): Promise<Category> {
    const category = await this.categoriesService.getOne(categoryId);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    return category;
  }

  // mutates the entity instead of copying it, so @Exclude() still applies
  private toView(transaction: LoadedTransaction): TransactionView {
    const view: TransactionView = transaction;

    if (transaction.wallet.is_deleted) {
      view.wallet = null;
    }

    return view;
  }
}
