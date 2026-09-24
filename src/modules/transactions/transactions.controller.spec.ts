import { Test, TestingModule } from '@nestjs/testing';

import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransactionType } from '@shared/enums';
import type { CreateTransactionDto } from './dto/create-transaction.dto';
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
          useValue: { create: jest.fn(), getAll: jest.fn(), getLatest: jest.fn(), remove: jest.fn() },
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
      transaction: buildTransaction({
        id: '99',
        category_id: 5,
        transaction_type: TransactionType.INCOME,
        amount: '50',
      }),
      wallet: Object.assign(buildWallet(), { balance: 150 }),
      previous_balance: 100,
    };
    transactionsService.create.mockResolvedValue(created);

    const result = await controller.create(req, spaceId, dto);

    expect(transactionsService.create).toHaveBeenCalledWith(1, spaceId, dto);
    expect(result).toBe(created);
  });

  it('getAll defaults the period to the current month', async () => {
    transactionsService.getAll.mockResolvedValue([]);

    await controller.getAll(req, spaceId);

    expect(transactionsService.getAll).toHaveBeenCalledWith(1, spaceId, expect.any(Date), expect.any(Date));
  });

  it('getAll passes an explicit period through', async () => {
    const from = new Date(2026, 0, 1);
    const to = new Date(2026, 0, 31);
    const transactions = [buildTransaction({ wallet: buildWallet(), category: buildCategory() })].map((transaction) =>
      withRelations(transaction, 'wallet', 'category'),
    );
    transactionsService.getAll.mockResolvedValue(transactions);

    const result = await controller.getAll(req, spaceId, from, to);

    expect(transactionsService.getAll).toHaveBeenCalledWith(1, spaceId, from, to);
    expect(result).toBe(transactions);
  });

  it('getLatest delegates to TransactionsService.getLatest', async () => {
    transactionsService.getLatest.mockResolvedValue(null);

    const result = await controller.getLatest(req, spaceId);

    expect(transactionsService.getLatest).toHaveBeenCalledWith(1, spaceId);
    expect(result).toBeNull();
  });

  it('remove delegates to TransactionsService.remove and returns true', async () => {
    const result = await controller.remove(req, spaceId, 'tx-1');

    expect(transactionsService.remove).toHaveBeenCalledWith(1, spaceId, 'tx-1');
    expect(result).toBe(true);
  });
});
