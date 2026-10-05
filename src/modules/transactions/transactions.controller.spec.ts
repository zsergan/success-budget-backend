import { Test, TestingModule } from '@nestjs/testing';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransactionType } from '@shared/enums';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
import type { UpdateTransactionResult } from './dto/transaction-responses';
import { toTransactionView } from './transaction-view';
import type { AuthedRequest } from '@shared/types';
import { withRelations } from '@shared/utils';
import { buildCategory, buildTransaction, buildWallet } from '@testing';

describe('TransactionsController', () => {
  let controller: TransactionsController;
  let transactionsService: jest.Mocked<TransactionsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        {
          provide: TransactionsService,
          useValue: {
            create: jest.fn(),
            getAll: jest.fn(),
            getLatest: jest.fn(),
            getById: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(TransactionsController);
    transactionsService = module.get(TransactionsService);
  });

  const req: AuthedRequest = { user: { id: 1 } };
  const spaceId = 10;

  it('create delegates to TransactionsService.create', async () => {
    const dto: CreateTransactionDto = {
      wallet_id: 1,
      category_id: 5,
      transaction_type: TransactionType.INCOME,
      amount: '50',
      timestamp: '2026-01-15T10:00:00.000Z',
    };
    const created = {
      transaction: toTransactionView(
        withRelations(
          buildTransaction({ id: '99', amount: '50.00', wallet: buildWallet(), category: buildCategory() }),
          'wallet',
          'category',
        ),
      ),
      wallet: Object.assign(buildWallet(), { balance: 150 }),
      previous_balance: 100,
    };
    transactionsService.create.mockResolvedValue(created);

    const result = await controller.create(req, spaceId, dto, 'key-1');

    expect(transactionsService.create).toHaveBeenCalledWith(1, spaceId, dto, { idempotencyKey: 'key-1' });
    expect(result).toBe(created);
  });

  it('getAll defaults the period to the current month', async () => {
    transactionsService.getAll.mockResolvedValue([]);

    await controller.getAll(req, spaceId);

    expect(transactionsService.getAll).toHaveBeenCalledWith(1, spaceId, expect.any(Date), expect.any(Date), {
      transactionType: undefined,
      categoryId: undefined,
      walletId: undefined,
    });
  });

  it('getAll passes an explicit period through', async () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);
    const transactions = [buildTransaction({ wallet: buildWallet(), category: buildCategory() })].map((transaction) =>
      toTransactionView(withRelations(transaction, 'wallet', 'category')),
    );
    transactionsService.getAll.mockResolvedValue(transactions);

    const result = await controller.getAll(req, spaceId, from, to);

    expect(transactionsService.getAll).toHaveBeenCalledWith(1, spaceId, from, to, {
      transactionType: undefined,
      categoryId: undefined,
      walletId: undefined,
    });
    expect(result).toBe(transactions);
  });

  it('getAll passes the history filters through', async () => {
    transactionsService.getAll.mockResolvedValue([]);
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);

    await controller.getAll(req, spaceId, from, to, TransactionType.EXPENSE, 5, 3);

    expect(transactionsService.getAll).toHaveBeenCalledWith(1, spaceId, from, to, {
      transactionType: TransactionType.EXPENSE,
      categoryId: 5,
      walletId: 3,
    });
  });

  it('getLatest delegates to TransactionsService.getLatest', async () => {
    transactionsService.getLatest.mockResolvedValue(null);

    const result = await controller.getLatest(req, spaceId);

    expect(transactionsService.getLatest).toHaveBeenCalledWith(1, spaceId);
    expect(result).toBeNull();
  });

  it('getById delegates to TransactionsService.getById', async () => {
    const view = toTransactionView(
      withRelations(
        buildTransaction({ id: 'tx-1', wallet: buildWallet(), category: buildCategory() }),
        'wallet',
        'category',
      ),
    );
    transactionsService.getById.mockResolvedValue(view);

    const result = await controller.getById(req, spaceId, 'tx-1');

    expect(transactionsService.getById).toHaveBeenCalledWith(1, spaceId, 'tx-1');
    expect(result).toBe(view);
  });

  it('update delegates the body and both headers to TransactionsService.update', async () => {
    const dto = { amount: '5.00' };
    const updated = { transaction: {}, wallets: [] } as unknown as UpdateTransactionResult;
    transactionsService.update.mockResolvedValue(updated);

    const result = await controller.update(req, spaceId, 'tx-1', dto, 2, 'key-1');

    expect(transactionsService.update).toHaveBeenCalledWith(1, spaceId, 'tx-1', dto, {
      expectedVersion: 2,
      idempotencyKey: 'key-1',
    });
    expect(result).toBe(updated);
  });

  it('remove delegates to TransactionsService.remove and returns true', async () => {
    const result = await controller.remove(req, spaceId, 'tx-1', 3, 'key-1');

    expect(transactionsService.remove).toHaveBeenCalledWith(1, spaceId, 'tx-1', {
      expectedVersion: 3,
      idempotencyKey: 'key-1',
    });
    expect(result).toBe(true);
  });
});
