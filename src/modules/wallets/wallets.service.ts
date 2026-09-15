import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Wallet } from '@entities/wallet.entity';
import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import type { UpdateWalletDto } from './dto/update-wallet.dto';
import { TransactionType } from '@shared/enums';
import { SpacesService } from '@modules/spaces/spaces.service';

export interface WalletSummary {
  wallet: Wallet;
  total_spend: number;
  total_income: number;
}

export interface WalletsOverview {
  total_balance: number;
  total_balance_currency: string;
  delta_percent: number;
  wallets: WalletSummary[];
}

export interface CreateWalletResult {
  wallet: Wallet;
  transaction: Transaction | null;
}

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly spacesService: SpacesService,
    private readonly dataSource: DataSource,
  ) {}

  async getOne(walletId: number): Promise<Wallet> {
    return await this.walletRepository.findOne({ where: { id: walletId } });
  }

  async getAll(spaceId: number): Promise<Wallet[]> {
    return await this.walletRepository
      .createQueryBuilder('wallet')
      .where({ space_id: spaceId, is_deleted: 0 })
      .getMany();
  }

  async create(spaceId: number, createWalletDto: CreateWalletDto): Promise<CreateWalletResult> {
    return this.dataSource.transaction(async (manager) => {
      const walletRepository = manager.getRepository(Wallet);
      const wallet = await walletRepository.save(
        walletRepository.create({
          space_id: spaceId,
          wallet_name: createWalletDto.wallet_name,
          design: createWalletDto.design,
        }),
      );

      const initialBalance = Number(createWalletDto.initial_balance);

      if (initialBalance <= 0) {
        wallet.balance = 0;
        return { wallet, transaction: null };
      }

      const systemCategory = await manager
        .getRepository(Category)
        .findOneOrFail({ where: { space_id: spaceId, is_system: 1 } });

      const transactionRepository = manager.getRepository(Transaction);
      const transaction = await transactionRepository.save(
        transactionRepository.create({
          wallet_id: wallet.id,
          category_id: systemCategory.id,
          transaction_type: TransactionType.INCOME,
          amount: initialBalance,
        }),
      );

      wallet.balance = initialBalance;

      return { wallet, transaction };
    });
  }

  async update(walletId: number, updateWalletDto: UpdateWalletDto): Promise<void> {
    await this.walletRepository.update({ id: walletId }, updateWalletDto);
  }

  async delete(walletId: number): Promise<void> {
    await this.walletRepository.update({ id: walletId }, { is_deleted: 1, deleted_at: new Date() });
  }

  summarize(wallets: Wallet[], transactions: Transaction[]): WalletSummary[] {
    return wallets.map((wallet) => {
      const walletTransactions = transactions.filter((transaction) => transaction.wallet_id === wallet.id);
      const totals = walletTransactions.reduce(
        (acc, transaction) => {
          if (transaction.transaction_type === TransactionType.INCOME) {
            acc.total_income += Number(transaction.amount);
          } else {
            acc.total_spend += Number(transaction.amount);
          }

          return acc;
        },
        { total_spend: 0, total_income: 0 },
      );

      return { wallet, ...totals };
    });
  }

  async buildOverview(
    spaceId: number,
    wallets: Wallet[],
    transactions: Transaction[],
    balances: Map<number, number>,
  ): Promise<WalletsOverview> {
    const space = await this.spacesService.getOne(spaceId);

    wallets.forEach((wallet) => {
      wallet.balance = balances.get(wallet.id) ?? 0;
    });

    const total_balance = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);

    const net = transactions.reduce((sum, transaction) => {
      const amount = Number(transaction.amount);

      return sum + (transaction.transaction_type === TransactionType.INCOME ? amount : -amount);
    }, 0);

    const balanceAtPeriodStart = total_balance - net;
    const delta_percent = balanceAtPeriodStart !== 0 ? Math.round((net / balanceAtPeriodStart) * 1000) / 10 : 0;

    return {
      total_balance,
      total_balance_currency: space.currency.code,
      delta_percent,
      wallets: this.summarize(wallets, transactions),
    };
  }
}
