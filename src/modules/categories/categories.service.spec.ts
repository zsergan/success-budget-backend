import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { In, Repository } from 'typeorm';

import { CategoriesService } from './categories.service';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { AppColor, CategoryIcon, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let categoryRepository: jest.Mocked<Repository<Category>>;
  let limitRepository: jest.Mocked<Repository<Limit>>;
  let categoryQueryBuilder: Record<string, jest.Mock>;
  let transactionQueryBuilder: Record<string, jest.Mock>;
  let limitQueryBuilder: Record<string, jest.Mock>;
  let limitRelationBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    categoryQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    transactionQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    limitRelationBuilder = { of: jest.fn().mockReturnThis(), remove: jest.fn() };
    limitQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      getCount: jest.fn().mockResolvedValue(2), // >1 by default; the ==1 case has its own test
      relation: jest.fn().mockReturnValue(limitRelationBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: getRepositoryToken(Category),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn((entity) => entity),
            save: jest.fn(),
            delete: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(categoryQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(transactionQueryBuilder) },
        },
        {
          provide: getRepositoryToken(Limit),
          useValue: {
            delete: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(limitQueryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(CategoriesService);
    categoryRepository = module.get(getRepositoryToken(Category));
    limitRepository = module.get(getRepositoryToken(Limit));
  });

  describe('getAll', () => {
    it('scopes to the space and orders by sort ascending', async () => {
      await service.getAll(2);

      expect(categoryQueryBuilder.where).toHaveBeenCalledWith('category.space_id = :spaceId', { spaceId: 2 });
      expect(categoryQueryBuilder.andWhere).toHaveBeenCalledWith('category.is_system = 0');
      expect(categoryQueryBuilder.orderBy).toHaveBeenCalledWith('category.sort', 'ASC');
    });

    it('splits active categories into incomes/expenses and archived into its own bucket', async () => {
      categoryQueryBuilder.getMany.mockResolvedValue([
        { id: 1, transaction_type: TransactionType.INCOME, is_active: 1 },
        { id: 2, transaction_type: TransactionType.EXPENSE, is_active: 1 },
        { id: 3, transaction_type: TransactionType.EXPENSE, is_active: 0 },
      ]);

      const result = await service.getAll(1);

      expect(result.incomes.map((c) => c.id)).toEqual([1]);
      expect(result.expenses.map((c) => c.id)).toEqual([2]);
      expect(result.archived.map((c) => c.id)).toEqual([3]);
    });

    it('attaches transaction counts and limit membership to each row', async () => {
      categoryQueryBuilder.getMany.mockResolvedValue([
        { id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 },
      ]);
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '4' }]);
      limitQueryBuilder.getRawMany.mockResolvedValue([{ limit_id: 7, limit_name: 'Fun', category_id: 1 }]);

      const result = await service.getAll(1);

      expect(result.expenses[0].transaction_count).toBe(4);
      expect(result.expenses[0].limit).toEqual({ id: 7, name: 'Fun' });
    });
  });

  describe('getMany', () => {
    it('fetches every requested category in a single query', async () => {
      categoryRepository.find.mockResolvedValue([{ id: 1 }, { id: 2 }] as Category[]);

      const result = await service.getMany([1, 2]);

      expect(categoryRepository.find).toHaveBeenCalledWith({ where: { id: In([1, 2]) } });
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('returns an empty array without querying when no ids are given', async () => {
      const result = await service.getMany([]);

      expect(result).toEqual([]);
      expect(categoryRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('merges the update onto the existing category', async () => {
      categoryRepository.findOne.mockResolvedValue({ id: 1, name: 'Old', sort: 1, is_active: 1 } as Category);
      categoryRepository.save.mockResolvedValue({} as Category);

      await service.update(1, { name: 'New' } as any);

      expect(categoryRepository.save).toHaveBeenCalledWith({ id: 1, name: 'New', sort: 1, is_active: 1 });
    });

    it('unlinks from its limit and stamps archived_at when is_active flips to 0', async () => {
      categoryRepository.findOne.mockResolvedValue({ id: 1, is_active: 1 } as Category);
      categoryRepository.save.mockResolvedValue({} as Category);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 7 });

      await service.update(1, { is_active: 0 } as any);

      expect(limitQueryBuilder.relation).toHaveBeenCalledWith('categories');
      expect(limitRelationBuilder.of).toHaveBeenCalledWith(7);
      expect(limitRelationBuilder.remove).toHaveBeenCalledWith([1]);
      expect(categoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, is_active: 0, archived_at: expect.any(Date) }),
      );
    });

    it('clears archived_at on restore (is_active flips to 1)', async () => {
      categoryRepository.findOne.mockResolvedValue({ id: 1, is_active: 0, archived_at: new Date() } as Category);
      categoryRepository.save.mockResolvedValue({} as Category);

      await service.update(1, { is_active: 1 } as any);

      expect(categoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, is_active: 1, archived_at: null }),
      );
    });
  });

  describe('create', () => {
    it('saves a new category for the space', async () => {
      categoryRepository.save.mockResolvedValue({} as Category);

      await service.create(9, {
        name: 'Food',
        transaction_type: TransactionType.EXPENSE,
        icon: CategoryIcon.GROCERY,
        color: AppColor.SLATE,
      });

      expect(categoryRepository.save).toHaveBeenCalledWith({
        name: 'Food',
        transaction_type: TransactionType.EXPENSE,
        icon: CategoryIcon.GROCERY,
        color: AppColor.SLATE,
        space_id: 9,
      });
    });
  });

  describe('deleteOrArchive', () => {
    it('hard-deletes a category with no transactions', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.deleteOrArchive(1);

      expect(categoryRepository.delete).toHaveBeenCalledWith(1);
      expect(result).toEqual({ archived: false });
    });

    it('archives and unlinks from its limit when transactions exist', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });

      const result = await service.deleteOrArchive(1);

      expect(limitRelationBuilder.of).toHaveBeenCalledWith(5);
      expect(limitRelationBuilder.remove).toHaveBeenCalledWith([1]);
      expect(categoryRepository.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ is_active: 0, archived_at: expect.any(Date) }),
      );
      expect(categoryRepository.delete).not.toHaveBeenCalled();
      expect(result).toEqual({ archived: true });
    });

    it('deletes the limit too when this was its only category', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });
      limitQueryBuilder.getCount.mockResolvedValue(1);

      await service.deleteOrArchive(1);

      expect(limitRepository.delete).toHaveBeenCalledWith(5);
    });

    it('keeps the limit when other categories still belong to it', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });
      limitQueryBuilder.getCount.mockResolvedValue(2);

      await service.deleteOrArchive(1);

      expect(limitRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('reorder', () => {
    it('reassigns sort with the expense prefix (200) in the given order', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 2, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 },
        { id: 1, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 },
        { id: 3, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 },
      ] as Category[]);
      categoryRepository.save.mockResolvedValue([] as any);

      await service.reorder(1, [2, 1, 3]);

      expect(categoryRepository.save).toHaveBeenCalledWith([
        { id: 2, sort: 201 },
        { id: 1, sort: 202 },
        { id: 3, sort: 203 },
      ]);
    });

    it('reassigns sort with the income prefix (100) in the given order', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 },
        { id: 2, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 },
      ] as Category[]);
      categoryRepository.save.mockResolvedValue([] as any);

      await service.reorder(1, [1, 2]);

      expect(categoryRepository.save).toHaveBeenCalledWith([
        { id: 1, sort: 101 },
        { id: 2, sort: 102 },
      ]);
    });

    it('rejects a category belonging to a different space', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 1, space_id: 2, transaction_type: TransactionType.EXPENSE, is_active: 1 },
      ] as Category[]);

      await expect(service.reorder(1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
    });

    it('rejects reordering a system category', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1, is_system: 1 },
      ] as Category[]);

      await expect(service.reorder(1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('rejects mixing income and expense categories in one reorder', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 },
        { id: 2, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 },
      ] as Category[]);

      await expect(service.reorder(1, [1, 2])).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_REORDER, 400),
      );
    });

    it('rejects reordering an archived category', async () => {
      categoryRepository.find.mockResolvedValue([
        { id: 1, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 0 },
      ] as Category[]);

      await expect(service.reorder(1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_REORDER, 400),
      );
    });
  });
});
