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

export interface WalletTotals {
  balance: number;
  period_income: number;
  period_spend: number;
}

export interface ExpenseTotals {
  total: number;
  byCategory: Map<number, number>;
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

  // one aggregated query for GET /spaces/:spaceId/wallets - replaces a raw
  // transaction-row fetch plus a separate all-time-balance query, since both
  // are the same SUM(...)-by-wallet_id shape and only differ by date filter
  async getWalletTotals(walletIds: number[], from: Date, to: Date): Promise<Map<number, WalletTotals>> {
    const totals = new Map(walletIds.map((id) => [id, { balance: 0, period_income: 0, period_spend: 0 }]));

    if (walletIds.length === 0) {
      return totals;
    }

    const rows = await this.transactionRepository
      .createQueryBuilder('transaction')
      .select('transaction.wallet_id', 'wallet_id')
      .addSelect(
        'SUM(CASE WHEN transaction.transaction_type = :income THEN transaction.amount ELSE -transaction.amount END)',
        'balance',
      )
      .addSelect(
        'SUM(CASE WHEN transaction.transaction_type = :income AND transaction.timestamp >= :from AND transaction.timestamp <= :to THEN transaction.amount ELSE 0 END)',
        'period_income',
      )
      .addSelect(
        'SUM(CASE WHEN transaction.transaction_type = :expense AND transaction.timestamp >= :from AND transaction.timestamp <= :to THEN transaction.amount ELSE 0 END)',
        'period_spend',
      )
      .where('transaction.wallet_id IN (:...walletIds)', { walletIds })
      .setParameter('income', TransactionType.INCOME)
      .setParameter('expense', TransactionType.EXPENSE)
      .setParameter('from', from)
      .setParameter('to', to)
      .groupBy('transaction.wallet_id')
      .getRawMany<{ wallet_id: string; balance: string; period_income: string; period_spend: string }>();

    rows.forEach((row) =>
      totals.set(Number(row.wallet_id), {
        balance: Number(row.balance),
        period_income: Number(row.period_income),
        period_spend: Number(row.period_spend),
      }),
    );

    return totals;
  }

  // one aggregated query for GET /spaces/:spaceId/limits - the total and
  // every category limit's spend all come out of the same
  // space-wide expense GROUP BY, including history of deleted wallets
  // (limits track space spend, not per-wallet)
  async getExpenseTotals(spaceId: number, from: Date, to: Date): Promise<ExpenseTotals> {
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

    const byCategory = new Map(rows.map((row) => [Number(row.category_id), Number(row.spent)]));
    const total = rows.reduce((sum, row) => sum + Number(row.spent), 0);

    return { total, byCategory };
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
