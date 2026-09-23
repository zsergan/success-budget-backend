import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '@entities/transaction.entity';
import { Wallet } from '@entities/wallet.entity';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionType } from '@shared/enums';

export interface CreateTransactionResult {
  transaction: Transaction;
  wallet: Wallet;
  previous_balance: number;
}

export interface WalletPeriodTotals {
  income: number;
  spend: number;
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
  ) {}

  async create(wallet: Wallet, createTransactionDto: CreateTransactionDto): Promise<CreateTransactionResult> {
    const balances = await this.getBalances([wallet.id]);
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

  // shared by GET /spaces/:spaceId/wallets and create()'s previous_balance -
  // no lock, informational only: the balance is always recomputed from
  // history and never depends on the order concurrent requests resolve in
  async getBalances(walletIds: number[]): Promise<Map<number, number>> {
    const balances = new Map(walletIds.map((id) => [id, 0]));

    if (walletIds.length === 0) {
      return balances;
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect(
        'SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE -transaction.amount END)',
        'balance',
      )
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .setParameter('income', TransactionType.INCOME)
      .groupBy('transaction.wallet_id')
      .getRawMany<{ wallet_id: string; balance: string }>();

    rows.forEach((row) => balances.set(Number(row.wallet_id), Number(row.balance)));

    return balances;
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
      .where({ wallet_id: walletId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }

  // one aggregated query for GET /spaces/:spaceId/wallets - the period
  // income/spend per wallet, grouped in SQL instead of filtering a raw
  // transaction-row fetch in JS. All-time balance is a separate concern,
  // still served by getBalances().
  async getPeriodTotals(walletIds: number[], from: Date, to: Date): Promise<Map<number, WalletPeriodTotals>> {
    const totals = new Map(walletIds.map((id) => [id, { income: 0, spend: 0 }]));

    if (walletIds.length === 0) {
      return totals;
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE 0 END)', 'income')
      .addSelect('SUM(CASE WHEN transaction.transaction_type = :expense THEN transaction.amount ELSE 0 END)', 'spend')
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .setParameter('income', TransactionType.INCOME)
      .setParameter('expense', TransactionType.EXPENSE)
      .groupBy('transaction.wallet_id')
      .getRawMany<{ wallet_id: string; income: string; spend: string }>();

    rows.forEach((row) => totals.set(Number(row.wallet_id), { income: Number(row.income), spend: Number(row.spend) }));

    return totals;
  }

  // one aggregated query for GET /spaces/:spaceId/limits - every category's
  // expense spend for the period, grouped in SQL. Joined to wallet only to
  // scope by space_id (still includes deleted-wallet history, since limits
  // track space spend, not per-wallet); no wallet/category entities loaded.
  async getExpensesByCategory(spaceId: number, from: Date, to: Date): Promise<Map<number, number>> {
    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoin('transaction.wallet', 'wallet')
      .select('transaction.category_id', 'category_id')
      .addSelect('SUM(transaction.amount)', 'spent')
      .where('wallet.space_id = :spaceId', { spaceId })
      .andWhere('transaction.transaction_type = :expense', { expense: TransactionType.EXPENSE })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .groupBy('transaction.category_id')
      .getRawMany<{ category_id: number; spent: string }>();

    return new Map(rows.map((row) => [Number(row.category_id), Number(row.spent)]));
  }

  async getForAllWallets(spaceId: number, from: Date, to: Date): Promise<Transaction[]> {
    return this.transactionRepository
      .createQueryBuilder('transaction')
      .innerJoinAndSelect('transaction.wallet', 'wallet')
      .innerJoinAndSelect('transaction.category', 'category')
      .where('wallet.space_id = :spaceId', { spaceId })
      .andWhere('transaction.timestamp >= :from', { from })
      .andWhere('transaction.timestamp <= :to', { to })
      .orderBy('transaction.timestamp', 'DESC')
      .getMany();
  }

  async getLatest(spaceId: number): Promise<Transaction | null> {
    return (
      this.transactionRepository
        .createQueryBuilder('transaction')
        .innerJoinAndSelect('transaction.wallet', 'wallet')
        .innerJoinAndSelect('transaction.category', 'category')
        .where('wallet.space_id = :spaceId', { spaceId })
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
