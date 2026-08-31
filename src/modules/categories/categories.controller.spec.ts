import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ErrorMessages } from '../../shared/error-messages';
import { TransactionType } from '../../shared/enums';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let categoriesService: jest.Mocked<CategoriesService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        {
          provide: CategoriesService,
          useValue: { getAll: jest.fn(), getOne: jest.fn(), update: jest.fn(), create: jest.fn(), save: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(CategoriesController);
    categoriesService = module.get(CategoriesService);
  });

  const req = { user: { id: 1 } } as any;

  describe('getAll', () => {
    it('separates categories into incomes and expenses', async () => {
      categoriesService.getAll.mockResolvedValue([
        { id: 1, transaction_type: TransactionType.INCOME },
        { id: 2, transaction_type: TransactionType.EXPENSE },
        { id: 3, transaction_type: TransactionType.INCOME },
      ] as any);

      const result = await controller.getAll(req);

      expect(result.incomes.map((c: any) => c.id)).toEqual([1, 3]);
      expect(result.expenses.map((c: any) => c.id)).toEqual([2]);
    });
  });

  describe('update', () => {
    it('rejects updating a category owned by someone else', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.update(req, 1, {} as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoriesService.update).not.toHaveBeenCalled();
    });

    it('updates a category owned by the current user', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, user_id: 1 } as any);

      await controller.update(req, 1, { name: 'New' } as any);

      expect(categoriesService.update).toHaveBeenCalledWith(1, { name: 'New' });
    });
  });

  describe('create', () => {
    it('creates a category for the current user', async () => {
      categoriesService.create.mockResolvedValue({ id: 5 } as any);

      const result = await controller.create(req, { name: 'Food' } as any);

      expect(categoriesService.create).toHaveBeenCalledWith(1, { name: 'Food' });
      expect(result).toEqual({ id: 5 });
    });
  });

  describe('moveForward', () => {
    it('rejects moving a category owned by someone else', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.moveForward(req, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoriesService.save).not.toHaveBeenCalled();
    });

    it('moves an expense category to the front of the expense group with prefix 200', async () => {
      categoriesService.getOne.mockResolvedValue({
        id: 2,
        user_id: 1,
        transaction_type: TransactionType.EXPENSE,
      } as any);
      categoriesService.getAll.mockResolvedValue([
        { id: 1, user_id: 1, transaction_type: TransactionType.EXPENSE },
        { id: 2, user_id: 1, transaction_type: TransactionType.EXPENSE },
        { id: 3, user_id: 1, transaction_type: TransactionType.EXPENSE },
      ] as any);

      await controller.moveForward(req, 2);

      expect(categoriesService.save).toHaveBeenCalledWith([
        expect.objectContaining({ id: 2, sort: 200 }),
        expect.objectContaining({ id: 1, sort: 201 }),
        expect.objectContaining({ id: 3, sort: 202 }),
      ]);
    });

    it('moves an income category to the front of the income group with prefix 100', async () => {
      categoriesService.getOne.mockResolvedValue({
        id: 1,
        user_id: 1,
        transaction_type: TransactionType.INCOME,
      } as any);
      categoriesService.getAll.mockResolvedValue([
        { id: 1, user_id: 1, transaction_type: TransactionType.INCOME },
        { id: 2, user_id: 1, transaction_type: TransactionType.INCOME },
      ] as any);

      await controller.moveForward(req, 1);

      expect(categoriesService.save).toHaveBeenCalledWith([
        expect.objectContaining({ id: 1, sort: 100 }),
        expect.objectContaining({ id: 2, sort: 101 }),
      ]);
    });
  });
});
