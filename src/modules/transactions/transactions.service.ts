import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '../../entities/transaction.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  async create(currencyId: number, createTransactionDto: CreateTransactionDto): Promise<Transaction> {
    const transaction = this.transactionRepository.create({ ...createTransactionDto, currency_id: currencyId });
    return await this.transactionRepository.save(transaction);
  }

  async getAll(walletId: number, from: Date, to: Date): Promise<Transaction[]> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.user_category', 'user_category')
      .innerJoinAndSelect('transaction.currency', 'currency')
      .where({ wallet_id: walletId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }

  async getForAllWallets(userId: number, from: Date, to: Date): Promise<Transaction[]> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.user_category', 'user_category')
      .innerJoinAndSelect('transaction.currency', 'currency')
      .where('wallet.user_id = :userId', { userId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }
}
