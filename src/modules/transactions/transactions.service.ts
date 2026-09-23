import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertBelongsToSpace } from '@shared/utils';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';

export interface CreateTransactionResult {
  transaction: Transaction;
  wallet: Wallet;
  previous_balance: number;
}

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

    const wallet = await this.walletsService.getOne(createTransactionDto.wallet_id);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    if (wallet.is_deleted) {
      throw new HttpException(ErrorMessages.FORBIDDEN_WALLET, HttpStatus.FORBIDDEN);
    }

    const category = await this.categoriesService.getOne(createTransactionDto.category_id);
    assertBelongsToSpace(category, spaceId, ErrorMessages.FORBIDDEN_CATEGORY);

    if (category.is_system) {
      throw new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, HttpStatus.FORBIDDEN);
    }

    const balances = await this.transactionQueriesService.getBalances([wallet.id]);
    const previousBalance = balances.get(wallet.id) ?? 0;

    const transaction = this.transactionRepository.create(createTransactionDto);
    const savedTransaction = await this.transactionRepository.save(transaction);

    const amount = Number(createTransactionDto.amount);
    const balanceChange = createTransactionDto.transaction_type === TransactionType.INCOME ? amount : -amount;
    wallet.balance = previousBalance + balanceChange;

    return { transaction: savedTransaction, wallet, previous_balance: previousBalance };
  }

  async getAll(userId: number, spaceId: number, from: Date, to: Date): Promise<Transaction[]> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transactions = await this.transactionQueriesService.getForAllWallets(spaceId, from, to);
    transactions.forEach((transaction) => this.hideDeletedWallet(transaction));

    return transactions;
  }

  async getLatest(userId: number, spaceId: number): Promise<Transaction | null> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getLatest(spaceId);

    if (!transaction) {
      return null;
    }

    this.hideDeletedWallet(transaction);

    return transaction;
  }

  async remove(userId: number, spaceId: number, transactionId: string): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const transaction = await this.transactionQueriesService.getOneWithWallet(transactionId);
    assertBelongsToSpace(transaction?.wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    await this.transactionRepository.delete(transaction.id);
  }

  private hideDeletedWallet(transaction: Transaction): void {
    if (transaction.wallet.is_deleted) {
      transaction.wallet = null;
    }
  }
}
