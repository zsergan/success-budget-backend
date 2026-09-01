import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Transaction } from '../../entities/transaction.entity';
import { Wallet } from '../../entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '../../shared/enums';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly dataSource: DataSource,
  ) {}

  async create(walletId: number, currencyId: number, createTransactionDto: CreateTransactionDto): Promise<Transaction> {
    return this.dataSource.transaction(async (manager) => {
      const walletRepository = manager.getRepository(Wallet);
      const wallet = await walletRepository.findOne({
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      });

      const balanceChange =
        createTransactionDto.transaction_type === TransactionType.INCOME
          ? Number(createTransactionDto.amount)
          : -Number(createTransactionDto.amount);

      await walletRepository.update(walletId, { balance: Number(wallet.balance) + balanceChange });

      const transactionRepository = manager.getRepository(Transaction);
      const transaction = transactionRepository.create({ ...createTransactionDto, currency_id: currencyId });

      return transactionRepository.save(transaction);
    });
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
}
