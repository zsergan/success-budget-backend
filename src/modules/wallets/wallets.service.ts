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
import { assertBelongsToSpace, assertFound, moneyToNumber, parseMoney, roundPercentToTenth } from '@shared/utils';
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

  async getOne(walletId: number): Promise<Wallet | null> {
    return this.walletRepository.findOne({ where: { id: walletId } });
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

      const initialBalance = parseMoney(createWalletDto.initial_balance);

      if (initialBalance === 0n) {
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

      const amount = moneyToNumber(initialBalance);
      const transaction: InitialBalanceTransaction = Object.assign(saved, { amount });

      return { wallet: Object.assign(wallet, { balance: amount }), transaction };
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

  private async buildOverview(
    spaceId: number,
    walletRows: Wallet[],
    periodTotals: Map<number, WalletPeriodTotals>,
    balances: Map<number, bigint>,
  ): Promise<WalletsOverview> {
    const space = await this.spacesService.getOne(spaceId);
    assertFound(space);

    let totalBalance = 0n;
    let net = 0n;

    const wallets = walletRows.map((row): WalletSummary => {
      const balance = balances.get(row.id) ?? 0n;
      const { income, spend } = periodTotals.get(row.id) ?? { income: 0n, spend: 0n };

      totalBalance += balance;
      net += income - spend;

      return {
        wallet: Object.assign(row, { balance: moneyToNumber(balance) }),
        total_spend: moneyToNumber(spend),
        total_income: moneyToNumber(income),
      };
    });

    return {
      total_balance: moneyToNumber(totalBalance),
      total_balance_currency: space.currency.code,
      delta_percent: roundPercentToTenth(net, totalBalance - net),
      wallets,
    };
  }
}
