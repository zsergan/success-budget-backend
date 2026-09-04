import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '@shared/enums';

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
    private readonly dataSource: DataSource,
  ) {}

  async create(
    walletId: number,
    currencyId: number,
    createTransactionDto: CreateTransactionDto,
  ): Promise<CreateTransactionResult> {
    return this.dataSource.transaction(async (manager) => {
      const walletRepository = manager.getRepository(Wallet);
      const wallet = await walletRepository.findOne({
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      });

      const previousBalance = Number(wallet.balance);
      const balanceChange =
        createTransactionDto.transaction_type === TransactionType.INCOME
          ? Number(createTransactionDto.amount)
          : -Number(createTransactionDto.amount);
      const newBalance = previousBalance + balanceChange;

      await walletRepository.update(walletId, { balance: newBalance });
      // Mutate the loaded entity instance (not a spread copy) so its
      // @Exclude() metadata survives ClassSerializerInterceptor - see
      // .private/modernization-plan.md, "Этап 15" on the spread-before-save leak.
      wallet.balance = newBalance;

      const transactionRepository = manager.getRepository(Transaction);
      const transaction = transactionRepository.create({ ...createTransactionDto, currency_id: currencyId });
      const savedTransaction = await transactionRepository.save(transaction);

      return { transaction: savedTransaction, wallet, previous_balance: previousBalance };
    });
  }

  async remove(transaction: Transaction): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const walletRepository = manager.getRepository(Wallet);
      const wallet = await walletRepository.findOne({
        where: { id: transaction.wallet_id },
        lock: { mode: 'pessimistic_write' },
      });

      const balanceChange =
        transaction.transaction_type === TransactionType.INCOME
          ? -Number(transaction.amount)
          : Number(transaction.amount);

      await walletRepository.update(wallet.id, { balance: Number(wallet.balance) + balanceChange });

      const transactionRepository = manager.getRepository(Transaction);
      await transactionRepository.delete(transaction.id);
    });
  }

  async getOneWithWallet(transactionId: string): Promise<Transaction | null> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .where('transaction.id = :transactionId', { transactionId })
      .getOne();
  }

  async getAll(walletId: number, from: Date, to: Date): Promise<Transaction[]> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .innerJoinAndSelect('transaction.currency', 'currency')
      .where({ wallet_id: walletId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }

  async getAllForWallets(walletIds: number[], from: Date, to: Date): Promise<Transaction[]> {
    if (walletIds.length === 0) {
      return [];
    }

    return this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .getMany();
  }

  async getForAllWallets(userId: number, from: Date, to: Date): Promise<Transaction[]> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .innerJoinAndSelect('transaction.currency', 'currency')
      .where('wallet.user_id = :userId', { userId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }

  async getLatest(userId: number): Promise<Transaction | null> {
    return (
      this.transactionRepository
        .createQueryBuilder('transaction')
        .innerJoinAndSelect('transaction.wallet', 'wallet')
        .innerJoinAndSelect('transaction.category', 'category')
        .innerJoinAndSelect('transaction.currency', 'currency')
        .where('wallet.user_id = :userId', { userId })
        .orderBy('transaction.timestamp', 'DESC')
        // Deterministic tie-break for the (now rare, since timestamp is
        // millisecond-precision) case of two transactions landing on the
        // exact same value - a single "latest" result can't be left to
        // depend on MySQL's unspecified tie order.
        .addOrderBy('transaction.id', 'DESC')
        .limit(1)
        .getOne()
    );
  }
}
