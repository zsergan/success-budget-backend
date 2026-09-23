import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '@shared/enums';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

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
  ) {}

  async create(wallet: Wallet, createTransactionDto: CreateTransactionDto): Promise<CreateTransactionResult> {
    const balances = await this.transactionQueriesService.getBalances([wallet.id]);
    const previousBalance = balances.get(wallet.id) ?? 0;

    const transaction = this.transactionRepository.create(createTransactionDto);
    const savedTransaction = await this.transactionRepository.save(transaction);

    const amount = Number(createTransactionDto.amount);
    const balanceChange = createTransactionDto.transaction_type === TransactionType.INCOME ? amount : -amount;
    wallet.balance = previousBalance + balanceChange;

    return { transaction: savedTransaction, wallet, previous_balance: previousBalance };
  }

  async remove(transaction: Transaction): Promise<void> {
    await this.transactionRepository.delete(transaction.id);
  }
}
