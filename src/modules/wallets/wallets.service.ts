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
import type { WalletTotals } from '@modules/transactions/transactions.service';

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
          // set explicitly, in JS, rather than left to the column's DB-side
          // CURRENT_TIMESTAMP(3) default - the dev DB's server time zone is
          // not UTC, so a DB-computed default would be off by several hours
          timestamp: new Date(),
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

  summarize(wallets: Wallet[], totals: Map<number, WalletTotals>): WalletSummary[] {
    return wallets.map((wallet) => {
      const walletTotals = totals.get(wallet.id);

      return {
        wallet,
        total_spend: walletTotals?.period_spend ?? 0,
        total_income: walletTotals?.period_income ?? 0,
      };
    });
  }

  async buildOverview(spaceId: number, wallets: Wallet[], totals: Map<number, WalletTotals>): Promise<WalletsOverview> {
    const space = await this.spacesService.getOne(spaceId);

    wallets.forEach((wallet) => {
      wallet.balance = totals.get(wallet.id)?.balance ?? 0;
    });

    const total_balance = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);

    const net = wallets.reduce((sum, wallet) => {
      const walletTotals = totals.get(wallet.id);

      return sum + (walletTotals ? walletTotals.period_income - walletTotals.period_spend : 0);
    }, 0);

    const balanceAtPeriodStart = total_balance - net;
    const delta_percent = balanceAtPeriodStart !== 0 ? Math.round((net / balanceAtPeriodStart) * 1000) / 10 : 0;

    return {
      total_balance,
      total_balance_currency: space.currency.code,
      delta_percent,
      wallets: this.summarize(wallets, totals),
    };
  }
}
