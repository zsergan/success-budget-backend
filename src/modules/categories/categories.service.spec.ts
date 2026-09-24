import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { CategoriesService } from './categories.service';
import { Category } from '@entities/category.entity';
import { Transaction } from '@entities/transaction.entity';
import { Limit } from '@entities/limit.entity';
import { AppColor, CategoryIcon, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { buildCategory } from '@testing';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let categoryRepository: jest.Mocked<Repository<Category>>;
  let limitRepository: jest.Mocked<Repository<Limit>>;
  let categoryQueryBuilder: Record<string, jest.Mock>;
  let transactionQueryBuilder: Record<string, jest.Mock>;
  let limitQueryBuilder: Record<string, jest.Mock>;
  let limitRelationBuilder: Record<string, jest.Mock>;
  let spaceAccessService: jest.Mocked<SpaceAccessService>;
  let dataSource: { transaction: jest.Mock };
  let manager: { getRepository: jest.Mock };

  const userId = 42;
  const forbiddenSpace = new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

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

    limitRelationBuilder = {
      of: jest.fn().mockReturnThis(),
      remove: jest.fn(),
      loadMany: jest.fn().mockResolvedValue([buildCategory({ id: 2 })]),
    };
    limitQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
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
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        { provide: SpaceAccessService, useValue: { assertMembership: jest.fn(), lockSpace: jest.fn() } },
      ],
    }).compile();

    service = module.get(CategoriesService);
    categoryRepository = module.get(getRepositoryToken(Category));
    limitRepository = module.get(getRepositoryToken(Limit));
    spaceAccessService = module.get(SpaceAccessService);

    const repositories = new Map<unknown, unknown>([
      [Category, categoryRepository],
      [Transaction, module.get(getRepositoryToken(Transaction))],
      [Limit, limitRepository],
    ]);
    manager = { getRepository: jest.fn((entity) => repositories.get(entity)) };
    dataSource = module.get(DataSource);
    dataSource.transaction.mockImplementation((callback: (m: typeof manager) => unknown) => callback(manager));
  });

  describe('transaction boundary', () => {
    const spaceId = 3;
    let txCategoryRepository: Record<string, jest.Mock>;
    let txLimitRepository: Record<string, jest.Mock>;

    beforeEach(() => {
      txCategoryRepository = {
        findOne: jest.fn().mockResolvedValue(buildCategory({ id: 1, space_id: spaceId, is_active: 1 })),
        save: jest.fn((category) => category),
        update: jest.fn(),
        delete: jest.fn(),
      };
      txLimitRepository = { delete: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(limitQueryBuilder) };
      const txTransactionRepository = { createQueryBuilder: jest.fn().mockReturnValue(transactionQueryBuilder) };
      const repositories = new Map<unknown, unknown>([
        [Category, txCategoryRepository],
        [Transaction, txTransactionRepository],
        [Limit, txLimitRepository],
      ]);
      manager.getRepository.mockImplementation((entity) => repositories.get(entity));
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });
      limitRelationBuilder.loadMany.mockResolvedValue([]);
    });

    it.each([
      ['archive via update', () => service.update(userId, spaceId, 1, { is_active: 0 })],
      ['archive via delete', () => service.deleteOrArchive(userId, spaceId, 1)],
      ['delete', () => service.deleteOrArchive(userId, spaceId, 1)],
    ])('%s locks the space first and runs every query through the transaction manager', async (name, run) => {
      transactionQueryBuilder.getRawMany.mockResolvedValue(
        name === 'archive via delete' ? [{ category_id: '1', count: '3' }] : [],
      );

      await run();

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.lockSpace).toHaveBeenCalledWith(spaceId, manager);
      const lockOrder = spaceAccessService.lockSpace.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(spaceAccessService.assertMembership.mock.invocationCallOrder[0]);
      expect(lockOrder).toBeLessThan(manager.getRepository.mock.invocationCallOrder[0]);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId, undefined, manager);
      expect(txCategoryRepository.findOne).toHaveBeenCalled();
      expect(txLimitRepository.delete).toHaveBeenCalledWith(5);
      expect(categoryRepository.findOne).not.toHaveBeenCalled();
      expect(categoryRepository.save).not.toHaveBeenCalled();
      expect(categoryRepository.update).not.toHaveBeenCalled();
      expect(categoryRepository.delete).not.toHaveBeenCalled();
      expect(limitRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(limitRepository.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['update', () => service.update(userId, spaceId, 1, { is_active: 0 }), 'save'],
      ['deleteOrArchive', () => service.deleteOrArchive(userId, spaceId, 1), 'update'],
    ])('%s propagates a failed category write after unlinking', async (_, run, write) => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      const failure = new Error('write failed');
      txCategoryRepository[write].mockRejectedValue(failure);

      await expect(run()).rejects.toBe(failure);
      expect(limitRelationBuilder.remove).toHaveBeenCalledWith([1]);
    });
  });

  describe('getAll', () => {
    it('rejects a non-member before querying', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.getAll(userId, 2)).rejects.toMatchObject(forbiddenSpace);
      expect(categoryQueryBuilder.getMany).not.toHaveBeenCalled();
    });

    it('scopes to the space and orders by sort ascending', async () => {
      await service.getAll(userId, 2);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(2, userId);
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

      const result = await service.getAll(userId, 1);

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

      const result = await service.getAll(userId, 1);

      expect(result.expenses[0].transaction_count).toBe(4);
      expect(result.expenses[0].limit).toEqual({ id: 7, name: 'Fun' });
    });
  });

  describe('getMany', () => {
    it('fetches every requested category in a single query', async () => {
      const categories = [buildCategory({ id: 1 }), buildCategory({ id: 2 })];
      categoryRepository.find.mockResolvedValue(categories);

      const result = await service.getMany([1, 2]);

      expect(categoryRepository.find).toHaveBeenCalledWith({ where: { id: In([1, 2]) } });
      expect(result).toBe(categories);
    });

    it('returns an empty array without querying when no ids are given', async () => {
      const result = await service.getMany([]);

      expect(result).toEqual([]);
      expect(categoryRepository.find).not.toHaveBeenCalled();
    });

    it('deduplicates repeated ids before querying', async () => {
      categoryRepository.find.mockResolvedValue([buildCategory({ id: 5 })]);

      await service.getMany([5, 5, 5]);

      expect(categoryRepository.find).toHaveBeenCalledWith({ where: { id: In([5]) } });
    });

    it('queries through the given entity manager instead of the injected repository', async () => {
      const categories = [buildCategory({ id: 1 })];
      const managerRepository = { find: jest.fn().mockResolvedValue(categories) };
      const manager = { getRepository: jest.fn().mockReturnValue(managerRepository) } as unknown as EntityManager;

      const result = await service.getMany([1], manager);

      expect(manager.getRepository).toHaveBeenCalledWith(Category);
      expect(managerRepository.find).toHaveBeenCalledWith({ where: { id: In([1]) } });
      expect(categoryRepository.find).not.toHaveBeenCalled();
      expect(result).toBe(categories);
    });
  });

  describe('update', () => {
    const spaceId = 3;

    it('rejects a non-member without loading the category', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.update(userId, spaceId, 1, {})).rejects.toMatchObject(forbiddenSpace);
      expect(categoryRepository.findOne).not.toHaveBeenCalled();
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('rejects a category that belongs to a different space', async () => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: 20 }));

      await expect(service.update(userId, spaceId, 1, {})).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('rejects a category that does not exist', async () => {
      categoryRepository.findOne.mockResolvedValue(null);

      await expect(service.update(userId, spaceId, 1, {})).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('rejects a system category', async () => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: spaceId, is_system: 1 }));

      await expect(service.update(userId, spaceId, 1, {})).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('merges the update onto the category it loaded and checked, reading it only once', async () => {
      categoryRepository.findOne.mockResolvedValue(
        buildCategory({
          id: 1,
          space_id: spaceId,
          name: 'Old',
          sort: 1,
          is_active: 1,
        }),
      );
      categoryRepository.save.mockResolvedValue(buildCategory());

      await service.update(userId, spaceId, 1, { name: 'New' });

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId, undefined, manager);
      expect(categoryRepository.findOne).toHaveBeenCalledTimes(1);
      expect(categoryRepository.save).toHaveBeenCalledWith(
        buildCategory({ id: 1, space_id: spaceId, name: 'New', sort: 1, is_active: 1 }),
      );
    });

    it('unlinks from its limit and stamps archived_at when is_active flips to 0', async () => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: spaceId, is_active: 1 }));
      categoryRepository.save.mockResolvedValue(buildCategory());
      limitQueryBuilder.getOne.mockResolvedValue({ id: 7 });

      await service.update(userId, spaceId, 1, { is_active: 0 });

      expect(limitQueryBuilder.relation).toHaveBeenCalledWith('categories');
      expect(limitRelationBuilder.of).toHaveBeenCalledWith(7);
      expect(limitRelationBuilder.remove).toHaveBeenCalledWith([1]);
      expect(categoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, is_active: 0, archived_at: expect.any(Date) }),
      );
    });

    it('clears archived_at on restore (is_active flips to 1)', async () => {
      categoryRepository.findOne.mockResolvedValue(
        buildCategory({
          id: 1,
          space_id: spaceId,
          is_active: 0,
          archived_at: new Date(),
        }),
      );
      categoryRepository.save.mockResolvedValue(buildCategory());

      await service.update(userId, spaceId, 1, { is_active: 1 });

      expect(categoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, is_active: 1, archived_at: null }),
      );
    });
  });

  describe('create', () => {
    it('rejects a non-member without saving', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(
        service.create(userId, 9, {
          name: 'Food',
          transaction_type: TransactionType.EXPENSE,
          icon: CategoryIcon.GROCERY,
          color: AppColor.EVERGREEN,
        }),
      ).rejects.toMatchObject(forbiddenSpace);
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('saves a new category for the space', async () => {
      categoryRepository.save.mockResolvedValue(buildCategory());

      await service.create(userId, 9, {
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
    const spaceId = 3;

    beforeEach(() => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: spaceId }));
    });

    it('rejects a non-member without loading the category', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.deleteOrArchive(userId, spaceId, 1)).rejects.toMatchObject(forbiddenSpace);
      expect(categoryRepository.findOne).not.toHaveBeenCalled();
      expect(categoryRepository.delete).not.toHaveBeenCalled();
    });

    it('rejects a category that belongs to a different space', async () => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: 20 }));

      await expect(service.deleteOrArchive(userId, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoryRepository.delete).not.toHaveBeenCalled();
      expect(categoryRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a system category', async () => {
      categoryRepository.findOne.mockResolvedValue(buildCategory({ id: 1, space_id: spaceId, is_system: 1 }));

      await expect(service.deleteOrArchive(userId, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(categoryRepository.delete).not.toHaveBeenCalled();
      expect(categoryRepository.update).not.toHaveBeenCalled();
    });

    it('hard-deletes a category with no transactions', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.deleteOrArchive(userId, spaceId, 1);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(categoryRepository.delete).toHaveBeenCalledWith(1);
      expect(result).toEqual({ archived: false });
    });

    it('unlinks a category with no transactions from its limit before deleting it', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });

      const result = await service.deleteOrArchive(userId, spaceId, 1);

      expect(limitRelationBuilder.of).toHaveBeenCalledWith(5);
      expect(limitRelationBuilder.remove).toHaveBeenCalledWith([1]);
      expect(limitRelationBuilder.remove.mock.invocationCallOrder[0]).toBeLessThan(
        categoryRepository.delete.mock.invocationCallOrder[0],
      );
      expect(categoryRepository.delete).toHaveBeenCalledWith(1);
      expect(result).toEqual({ archived: false });
    });

    it('archives and unlinks from its limit when transactions exist', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });

      const result = await service.deleteOrArchive(userId, spaceId, 1);

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
      limitRelationBuilder.loadMany.mockResolvedValue([]);

      await service.deleteOrArchive(userId, spaceId, 1);

      expect(limitRelationBuilder.remove.mock.invocationCallOrder[0]).toBeLessThan(
        limitRelationBuilder.loadMany.mock.invocationCallOrder[0],
      );
      expect(limitRepository.delete).toHaveBeenCalledWith(5);
    });

    it('keeps the limit when other categories still belong to it', async () => {
      transactionQueryBuilder.getRawMany.mockResolvedValue([{ category_id: '1', count: '3' }]);
      limitQueryBuilder.getOne.mockResolvedValue({ id: 5 });
      limitRelationBuilder.loadMany.mockResolvedValue([buildCategory({ id: 2 })]);

      await service.deleteOrArchive(userId, spaceId, 1);

      expect(limitRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('reorder', () => {
    it('rejects a non-member before loading categories', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace);

      await expect(service.reorder(userId, 1, [1])).rejects.toMatchObject(forbiddenSpace);
      expect(categoryRepository.find).not.toHaveBeenCalled();
    });

    it('reassigns sort with the expense prefix (200) in the given order', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 2, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 }),
        buildCategory({ id: 1, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 }),
        buildCategory({ id: 3, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 }),
      ]);

      await service.reorder(userId, 1, [2, 1, 3]);

      expect(categoryRepository.save).toHaveBeenCalledWith([
        { id: 2, sort: 201 },
        { id: 1, sort: 202 },
        { id: 3, sort: 203 },
      ]);
    });

    it('reassigns sort with the income prefix (100) in the given order', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 }),
        buildCategory({ id: 2, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 }),
      ]);

      await service.reorder(userId, 1, [1, 2]);

      expect(categoryRepository.save).toHaveBeenCalledWith([
        { id: 1, sort: 101 },
        { id: 2, sort: 102 },
      ]);
    });

    it('rejects a category belonging to a different space', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 1, space_id: 2, transaction_type: TransactionType.EXPENSE, is_active: 1 }),
      ]);

      await expect(service.reorder(userId, 1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
    });

    it('rejects reordering a system category', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1, is_system: 1 }),
      ]);

      await expect(service.reorder(userId, 1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.CATEGORY_IS_SYSTEM, 400),
      );
      expect(categoryRepository.save).not.toHaveBeenCalled();
    });

    it('rejects mixing income and expense categories in one reorder', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 1, space_id: 1, transaction_type: TransactionType.INCOME, is_active: 1 }),
        buildCategory({ id: 2, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 1 }),
      ]);

      await expect(service.reorder(userId, 1, [1, 2])).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_REORDER, 400),
      );
    });

    it('rejects reordering an archived category', async () => {
      categoryRepository.find.mockResolvedValue([
        buildCategory({ id: 1, space_id: 1, transaction_type: TransactionType.EXPENSE, is_active: 0 }),
      ]);

      await expect(service.reorder(userId, 1, [1])).rejects.toMatchObject(
        new HttpException(ErrorMessages.INVALID_REORDER, 400),
      );
    });
  });
});
