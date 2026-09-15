import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Wallet } from '@entities/wallet.entity';
import { Transaction } from '@entities/transaction.entity';
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

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly spacesService: SpacesService,
  ) {}

  async getOne(walletId: number): Promise<Wallet> {
    return await this.walletRepository.findOne({ where: { id: walletId } });
  }

  async getAll(spaceId: number): Promise<Wallet[]> {
    return await this.walletRepository
      .createQueryBuilder('wallet')
      .innerJoinAndSelect('wallet.currency', 'currency')
      .where({ space_id: spaceId, is_deleted: 0 })
      .getMany();
  }

  async create(spaceId: number, createWalletDto: CreateWalletDto): Promise<Wallet> {
    const wallet = this.walletRepository.create({
      ...createWalletDto,
      space_id: spaceId,
    });
    await this.walletRepository.save(wallet);

    return wallet;
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

  async buildOverview(spaceId: number, wallets: Wallet[], transactions: Transaction[]): Promise<WalletsOverview> {
    // Wallets in one space can still carry different currencies until
    // Spaces Stage 3 drops wallets.currency_id entirely - filter to the
    // space's own currency, same as before, just from the real space now
    // instead of the Stage-1 "guess a personal space" shim.
    const space = await this.spacesService.getOne(spaceId);
    const baseCurrencyWalletIds = new Set(
      wallets.filter((wallet) => wallet.currency_id === space.currency_id).map((wallet) => wallet.id),
    );

    const total_balance = wallets
      .filter((wallet) => baseCurrencyWalletIds.has(wallet.id))
      .reduce((sum, wallet) => sum + Number(wallet.balance), 0);

    const net = transactions
      .filter((transaction) => baseCurrencyWalletIds.has(transaction.wallet_id))
      .reduce((sum, transaction) => {
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
