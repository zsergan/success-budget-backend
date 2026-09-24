import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import type { UpdateWalletDto } from './dto/update-wallet.dto';
import { TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { assertBelongsToSpace } from '@shared/utils';
import { SpacesService } from '@modules/spaces/spaces.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import {
  TransactionQueriesService,
  type WalletPeriodTotals,
} from '@modules/transaction-queries/transaction-queries.service';

export interface WalletSummary {
  wallet: WalletWithBalance;
  total_spend: number;
  total_income: number;
}

export interface WalletsOverview {
  total_balance: number;
  total_balance_currency: string;
  delta_percent: number;
  wallets: WalletSummary[];
}

// POST /wallets returns the initial amount as a number, unlike DECIMAL
// reads - see docs/type-contract.md
export type InitialBalanceTransaction = Omit<Transaction, 'amount'> & { amount: number };

export interface CreateWalletResult {
  wallet: WalletWithBalance;
  transaction: InitialBalanceTransaction | null;
}

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly spacesService: SpacesService,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly transactionQueriesService: TransactionQueriesService,
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

  async getOverview(userId: number, spaceId: number, from: Date, to: Date): Promise<WalletsOverview> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    const wallets = await this.getAll(spaceId);
    const walletIds = wallets.map((wallet) => wallet.id);
    const [periodTotals, balances] = await Promise.all([
      this.transactionQueriesService.getPeriodTotals(walletIds, from, to),
      this.transactionQueriesService.getBalances(walletIds),
    ]);

    return this.buildOverview(spaceId, wallets, periodTotals, balances);
  }

  async create(userId: number, spaceId: number, createWalletDto: CreateWalletDto): Promise<CreateWalletResult> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

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
        return { wallet: Object.assign(wallet, { balance: 0 }), transaction: null };
      }

      const systemCategory = await manager
        .getRepository(Category)
        .findOneOrFail({ where: { space_id: spaceId, is_system: 1 } });

      const transactionRepository = manager.getRepository(Transaction);
      const saved = await transactionRepository.save(
        transactionRepository.create({
          wallet_id: wallet.id,
          category_id: systemCategory.id,
          transaction_type: TransactionType.INCOME,
          amount: createWalletDto.initial_balance,
          // set explicitly, in JS, rather than left to the column's DB-side
          // CURRENT_TIMESTAMP(3) default - the dev DB's server time zone is
          // not UTC, so a DB-computed default would be off by several hours
          timestamp: new Date(),
        }),
      );

      const transaction: InitialBalanceTransaction = Object.assign(saved, { amount: initialBalance });

      return { wallet: Object.assign(wallet, { balance: initialBalance }), transaction };
    });
  }

  async update(userId: number, spaceId: number, walletId: number, updateWalletDto: UpdateWalletDto): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);
    await this.getSpaceWallet(spaceId, walletId);

    await this.walletRepository.update({ id: walletId }, updateWalletDto);
  }

  async delete(userId: number, spaceId: number, walletId: number): Promise<void> {
    await this.spaceAccessService.assertMembership(spaceId, userId);
    await this.getSpaceWallet(spaceId, walletId);

    await this.walletRepository.update({ id: walletId }, { is_deleted: 1, deleted_at: new Date() });
  }

  private async getSpaceWallet(spaceId: number, walletId: number): Promise<Wallet> {
    const wallet = await this.getOne(walletId);
    assertBelongsToSpace(wallet, spaceId, ErrorMessages.FORBIDDEN_WALLET);

    return wallet;
  }

  private summarize(wallets: WalletWithBalance[], periodTotals: Map<number, WalletPeriodTotals>): WalletSummary[] {
    return wallets.map((wallet) => {
      const totals = periodTotals.get(wallet.id) ?? { income: 0, spend: 0 };

      return { wallet, total_spend: totals.spend, total_income: totals.income };
    });
  }

  private async buildOverview(
    spaceId: number,
    walletRows: Wallet[],
    periodTotals: Map<number, WalletPeriodTotals>,
    balances: Map<number, number>,
  ): Promise<WalletsOverview> {
    const space = await this.spacesService.getOne(spaceId);
    const wallets = walletRows.map((wallet) => Object.assign(wallet, { balance: balances.get(wallet.id) ?? 0 }));

    const total_balance = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);

    const totalIncome = wallets.reduce((sum, wallet) => sum + (periodTotals.get(wallet.id)?.income ?? 0), 0);
    const totalSpend = wallets.reduce((sum, wallet) => sum + (periodTotals.get(wallet.id)?.spend ?? 0), 0);
    const net = totalIncome - totalSpend;

    const balanceAtPeriodStart = total_balance - net;
    const delta_percent = balanceAtPeriodStart !== 0 ? Math.round((net / balanceAtPeriodStart) * 1000) / 10 : 0;

    return {
      total_balance,
      total_balance_currency: space.currency.code,
      delta_percent,
      wallets: this.summarize(wallets, periodTotals),
    };
  }
}
