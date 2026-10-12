import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { Wallet, type WalletWithBalance } from '@entities/wallet.entity';
import { Transaction } from '@entities/transaction.entity';
import { Category } from '@entities/category.entity';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import type { UpdateWalletDto } from './dto/update-wallet.dto';
import { TransactionType } from '@shared/enums';
import {
  assertBelongsToSpace,
  assertFound,
  lockRows,
  moneyToNumber,
  parseMoney,
  readSnapshot,
  roundPercentToTenth,
  runWriteTransaction,
} from '@shared/utils';
import { SpacesService, type SpaceWithCurrency } from '@modules/spaces/spaces.service';
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

  async getAll(spaceId: number, manager?: EntityManager): Promise<Wallet[]> {
    const repository = manager?.getRepository(Wallet) ?? this.walletRepository;

    return await repository.createQueryBuilder('wallet').where({ space_id: spaceId, is_deleted: 0 }).getMany();
  }

  async getOverview(userId: number, spaceId: number, from: Date, to: Date): Promise<WalletsOverview> {
    await this.spaceAccessService.assertMembership(spaceId, userId);

    // the wallets, balances and period totals of one response come from one
    // snapshot, so a balance never includes a transaction the totals miss
    return readSnapshot(this.dataSource, async (manager) => {
      const wallets = await this.getAll(spaceId, manager);
      const walletIds = wallets.map((wallet) => wallet.id);
      const periodTotals = await this.transactionQueriesService.getPeriodTotals(walletIds, from, to, manager);
      const balances = await this.transactionQueriesService.getBalances(walletIds, manager);
      const space = await this.spacesService.getOne(spaceId, manager);
      assertFound(space);

      return buildOverview(space, wallets, periodTotals, balances);
    });
  }

  async create(userId: number, spaceId: number, createWalletDto: CreateWalletDto): Promise<CreateWalletResult> {
    return this.write(userId, spaceId, async (manager) => {
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
        .createQueryBuilder(Category, 'category')
        .setLock('pessimistic_read')
        .where('category.space_id = :spaceId AND category.is_system = 1', { spaceId })
        .getOneOrFail();

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
    await this.write(userId, spaceId, async (manager) => {
      await this.lockSpaceWallet(manager, spaceId, walletId);
      await manager.getRepository(Wallet).update({ id: walletId }, updateWalletDto);
    });
  }

  async delete(userId: number, spaceId: number, walletId: number): Promise<void> {
    await this.write(userId, spaceId, async (manager) => {
      await this.lockSpaceWallet(manager, spaceId, walletId);
      await manager.getRepository(Wallet).update({ id: walletId }, { is_deleted: 1, deleted_at: new Date() });
    });
  }

  // Locks in the order of transaction writes (TransactionsService.write()):
  // member, space, wallet, categories. The member row stays locked until
  // commit, so access cannot be revoked between the check and the write.
  private write<T>(userId: number, spaceId: number, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return runWriteTransaction(this.dataSource, async (manager) => {
      await this.spaceAccessService.lockMembership(spaceId, userId, manager);
      await this.spaceAccessService.lockSpace(spaceId, manager, 'shared');

      return work(manager);
    });
  }

  private async lockSpaceWallet(manager: EntityManager, spaceId: number, walletId: number): Promise<Wallet> {
    const [wallet] = await lockRows(manager, Wallet, [walletId], 'exclusive');
    assertBelongsToSpace(wallet, spaceId, 'FORBIDDEN_WALLET');

    return wallet;
  }
}

function buildOverview(
  space: SpaceWithCurrency,
  walletRows: Wallet[],
  periodTotals: Map<number, WalletPeriodTotals>,
  balances: Map<number, bigint>,
): WalletsOverview {
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
