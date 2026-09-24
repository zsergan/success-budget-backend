import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { LimitsService } from './limits.service';
import { Limit } from '@entities/limit.entity';
import type { Category } from '@entities/category.entity';
import { LimitType } from '@shared/enums';
import { withRelations } from '@shared/utils';
import { buildCategory, buildLimit, buildSpaceMember } from '@testing';
import { ErrorMessages } from '@shared/error-messages';
import { CategoriesService } from '@modules/categories/categories.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { TransactionQueriesService } from '@modules/transaction-queries/transaction-queries.service';

describe('LimitsService', () => {
  let service: LimitsService;
  let repository: jest.Mocked<Repository<Limit>>;
  let queryBuilder: Record<string, jest.Mock>;
  let relationBuilder: Record<string, jest.Mock>;
  let categoriesService: jest.Mocked<Pick<CategoriesService, 'getMany'>>;
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership'>>;
  let transactionQueriesService: jest.Mocked<Pick<TransactionQueriesService, 'getExpensesByCategory'>>;

  const userId = 7;

  const limitWith = (overrides: Partial<Limit>, categoryIds: number[] = []): Limit =>
    buildLimit({ ...overrides, categories: categoryIds.map((id) => buildCategory({ id })) });
  const loadedLimit = (overrides: Partial<Limit>, categoryIds: number[] = []) =>
    withRelations(limitWith(overrides, categoryIds), 'categories');
  const spaceCategories = (...categories: Partial<Category>[]) => categories.map((c) => buildCategory(c));

  beforeEach(async () => {
    relationBuilder = {
      of: jest.fn().mockReturnThis(),
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
      relation: jest.fn().mockReturnValue(relationBuilder),
    };

    categoriesService = {
      getMany: jest.fn(async (ids: number[]) => [...new Set(ids)].map((id) => buildCategory({ id, space_id: 1 }))),
    };
    spaceAccessService = { assertMembership: jest.fn().mockResolvedValue(buildSpaceMember({ user_id: userId })) };
    transactionQueriesService = { getExpensesByCategory: jest.fn().mockResolvedValue(new Map()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LimitsService,
        {
          provide: getRepositoryToken(Limit),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
        { provide: CategoriesService, useValue: categoriesService },
        { provide: SpaceAccessService, useValue: spaceAccessService },
        { provide: TransactionQueriesService, useValue: transactionQueriesService },
      ],
    }).compile();

    service = module.get(LimitsService);
    repository = module.get(getRepositoryToken(Limit));
  });

  describe('create', () => {
    it('creates a total (monthly) limit when no categories are given', async () => {
      repository.create.mockImplementation((entityLike) => Object.assign(new Limit(), entityLike));
      repository.save.mockResolvedValue(buildLimit({ id: 1 }));
      repository.findOne.mockResolvedValue(limitWith({ id: 1 }));

      await service.create(userId, 1, { amount: '2000' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 1, limit_type: LimitType.OTHERS, name: null }),
      );
      expect(relationBuilder.add).not.toHaveBeenCalled();
    });

    it('creates a single-category limit and links it', async () => {
      repository.create.mockImplementation((entityLike) => Object.assign(new Limit(), entityLike));
      repository.save.mockResolvedValue(buildLimit({ id: 1 }));
      repository.findOne.mockResolvedValue(limitWith({ id: 1 }, [4]));

      await service.create(userId, 1, { category_ids: [4], amount: '100' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 1, limit_type: LimitType.CATEGORY, name: null }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([4]);
    });

    it('creates a named group limit covering multiple categories', async () => {
      repository.create.mockImplementation((entityLike) => Object.assign(new Limit(), entityLike));
      repository.save.mockResolvedValue(buildLimit({ id: 1 }));
      repository.findOne.mockResolvedValue(limitWith({ id: 1 }, [4, 5]));

      await service.create(userId, 1, { category_ids: [4, 5], name: 'Fun', amount: '220' });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ limit_type: LimitType.CATEGORY, name: 'Fun' }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([4, 5]);
    });

    it('rejects a group with more than one category and no name', async () => {
      await expect(service.create(userId, 1, { category_ids: [4, 5], amount: '220' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a category already claimed by another limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);

      await expect(service.create(userId, 1, { category_ids: [4], amount: '100' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a second monthly total limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);

      await expect(service.create(userId, 1, { amount: '2000' })).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates only the amount when categories are not touched', async () => {
      const current = limitWith({ id: 1, space_id: 1, name: null }, [4]);
      repository.findOne.mockResolvedValue(current);

      await service.update(userId, 1, 1, { amount: '200' });

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, { amount: '200' });
      expect(relationBuilder.add).not.toHaveBeenCalled();
      expect(relationBuilder.remove).not.toHaveBeenCalled();
    });

    it('switches a category limit to a monthly total limit', async () => {
      const current = limitWith({ id: 1, space_id: 1, name: null }, [4]);
      repository.findOne.mockResolvedValue(current);

      await service.update(userId, 1, 1, { category_ids: [] });

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ limit_type: LimitType.OTHERS, name: null }),
      );
      expect(relationBuilder.remove).toHaveBeenCalledWith([4]);
      expect(relationBuilder.add).not.toHaveBeenCalled();
    });

    it('switches a total limit to a single-category limit', async () => {
      const current = limitWith({ id: 1, space_id: 1, name: null });
      repository.findOne.mockResolvedValue(current);

      await service.update(userId, 1, 1, { category_ids: [7] });

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ limit_type: LimitType.CATEGORY, name: null }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([7]);
      expect(relationBuilder.remove).not.toHaveBeenCalled();
    });

    it('rejects turning a limit into an unnamed group', async () => {
      const current = limitWith({ id: 1, space_id: 1, name: null }, [4]);
      repository.findOne.mockResolvedValue(current);

      await expect(service.update(userId, 1, 1, { category_ids: [4, 5] })).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, 400),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('keeps the existing name when growing an already-named group', async () => {
      const current = limitWith({ id: 1, space_id: 1, name: 'Fun' }, [4, 5]);
      repository.findOne.mockResolvedValue(current);

      await service.update(userId, 1, 1, { category_ids: [4, 5, 6] });

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ name: 'Fun' }));
      expect(relationBuilder.add).toHaveBeenCalledWith([6]);
    });

    it('rejects switching to a category already claimed by another limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);
      const current = limitWith({ id: 1, space_id: 1, name: null }, [4]);
      repository.findOne.mockResolvedValue(current);

      await expect(service.update(userId, 1, 1, { category_ids: [9] })).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the limit by id', async () => {
      repository.findOne.mockResolvedValue(limitWith({ id: 1, space_id: 1 }));

      await service.remove(userId, 1, 1);

      expect(repository.delete).toHaveBeenCalledWith(1);
    });
  });

  describe('scenario access checks', () => {
    const spaceId = 1;
    const forbiddenSpace = () => new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

    beforeEach(() => {
      repository.create.mockImplementation((entityLike) => Object.assign(new Limit(), entityLike));
      repository.save.mockResolvedValue(buildLimit({ id: 1 }));
    });

    it.each([
      ['getSummary', () => service.getSummary(userId, spaceId)],
      ['create', () => service.create(userId, spaceId, { category_ids: [5], amount: '10' })],
      ['update', () => service.update(userId, spaceId, 1, { category_ids: [5] })],
      ['remove', () => service.remove(userId, spaceId, 1)],
    ])('%s rejects a non-member before touching limits or categories', async (_, run) => {
      spaceAccessService.assertMembership.mockRejectedValue(forbiddenSpace());

      await expect(run()).rejects.toMatchObject(forbiddenSpace());
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      expect(categoriesService.getMany).not.toHaveBeenCalled();
      expect(transactionQueriesService.getExpensesByCategory).not.toHaveBeenCalled();
    });

    it('getSummary checks membership once and calculates spending from the current month totals', async () => {
      const limits = [limitWith({ id: 1, limit_type: LimitType.OTHERS, amount: '100.00' })];
      queryBuilder.getMany.mockResolvedValue(limits);
      transactionQueriesService.getExpensesByCategory.mockResolvedValue(new Map([[5, 30]]));

      const result = await service.getSummary(userId, spaceId);

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(spaceId, userId);
      expect(transactionQueriesService.getExpensesByCategory).toHaveBeenCalledWith(
        spaceId,
        expect.any(Date),
        expect.any(Date),
      );
      expect(result.total).toMatchObject({ id: 1, spent: 30, in_percent: 30 });
    });

    it('create checks every category in a single batched call, passing the ids through unchanged', async () => {
      repository.findOne.mockResolvedValue(limitWith({ id: 1 }));

      await service.create(userId, spaceId, { category_ids: [5, 6, 5], name: 'Fun', amount: '10' });

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(categoriesService.getMany).toHaveBeenCalledTimes(1);
      expect(categoriesService.getMany).toHaveBeenCalledWith([5, 6, 5]);
    });

    it('create skips the category lookup for a monthly total limit', async () => {
      repository.findOne.mockResolvedValue(limitWith({ id: 1 }));

      await service.create(userId, spaceId, { amount: '2000' });

      expect(categoriesService.getMany).not.toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalled();
    });

    it.each([
      ['missing', spaceCategories(), ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['foreign-space', spaceCategories({ id: 5, space_id: 20 }), ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['system', spaceCategories({ id: 5, space_id: spaceId, is_system: 1 }), ErrorMessages.CATEGORY_IS_SYSTEM, 400],
    ])('create rejects a %s category before any limit rule runs', async (_, categories, message, status) => {
      categoriesService.getMany.mockResolvedValue(categories);

      await expect(service.create(userId, spaceId, { category_ids: [5], amount: '10' })).rejects.toMatchObject(
        new HttpException(message, status),
      );
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it.each<[string, Limit | null]>([
      ['missing', null],
      ['foreign-space', limitWith({ id: 1, space_id: 20 })],
    ])('update rejects a %s limit before loading categories', async (_, limit) => {
      repository.findOne.mockResolvedValue(limit);

      await expect(service.update(userId, spaceId, 1, { category_ids: [5] })).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(categoriesService.getMany).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it.each([
      ['foreign-space', spaceCategories({ id: 6, space_id: 20 }), ErrorMessages.FORBIDDEN_CATEGORY, 403],
      ['system', spaceCategories({ id: 6, space_id: spaceId, is_system: 1 }), ErrorMessages.CATEGORY_IS_SYSTEM, 400],
    ])('update rejects switching to a %s category', async (_, categories, message, status) => {
      repository.findOne.mockResolvedValue(limitWith({ id: 1, space_id: spaceId }, [5]));
      categoriesService.getMany.mockResolvedValue(categories);

      await expect(service.update(userId, spaceId, 1, { category_ids: [6] })).rejects.toMatchObject(
        new HttpException(message, status),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('update checks membership once and returns the refreshed limit', async () => {
      const current = limitWith({ id: 1, space_id: spaceId, name: null }, [5]);
      const refreshed = limitWith({ id: 1, space_id: spaceId, name: null, amount: '20.00' }, [6]);
      repository.findOne.mockResolvedValueOnce(current).mockResolvedValueOnce(refreshed);

      const result = await service.update(userId, spaceId, 1, { category_ids: [6], amount: '20' });

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(categoriesService.getMany).toHaveBeenCalledWith([6]);
      expect(relationBuilder.remove).toHaveBeenCalledWith([5]);
      expect(relationBuilder.add).toHaveBeenCalledWith([6]);
      expect(result).toBe(refreshed);
    });

    it.each<[string, Limit | null]>([
      ['missing', null],
      ['foreign-space', limitWith({ id: 1, space_id: 20 })],
    ])('remove rejects a %s limit', async (_, limit) => {
      repository.findOne.mockResolvedValue(limit);

      await expect(service.remove(userId, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_LIMIT, 403),
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('scopes limits to the space', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(3);

      expect(queryBuilder.where).toHaveBeenCalledWith('limit.space_id = :spaceId', { spaceId: 3 });
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('limit.categories', 'categories');
    });
  });

  describe('calculateSpending', () => {
    it('tracks the monthly total independently of category limits', () => {
      const limits = [
        loadedLimit({ id: 1, limit_type: LimitType.OTHERS, amount: '2000', name: null }),
        loadedLimit({ id: 2, limit_type: LimitType.CATEGORY, amount: '400', name: null }, [10]),
      ];
      // total = ALL expenses (350 + 50), not just the unclaimed 50 -
      // income never enters this aggregate in the first place
      const categoryTotals = new Map([
        [10, 350],
        [99, 50],
      ]);

      const result = service.calculateSpending(limits, categoryTotals);

      expect(result.total).toMatchObject({ id: 1, spent: 400, in_percent: 20 });
      expect(result.categories[0]).toMatchObject({ id: 2, spent: 350, in_percent: 87 });
      expect(result.over_allocation).toBeNull();
    });

    it('sums spend across every category in a group limit', () => {
      const limits = [loadedLimit({ id: 1, limit_type: LimitType.CATEGORY, amount: '220', name: 'Fun' }, [1, 2])];
      const categoryTotals = new Map([
        [1, 80],
        [2, 40],
      ]);

      const result = service.calculateSpending(limits, categoryTotals);

      expect(result.categories[0]).toMatchObject({ spent: 120, in_percent: 54 });
    });

    it('flags when category limits sum above the monthly total, as a note not an error', () => {
      const limits = [
        loadedLimit({ id: 1, limit_type: LimitType.OTHERS, amount: '2000', name: null }),
        loadedLimit({ id: 2, limit_type: LimitType.CATEGORY, amount: '900', name: null }, [1]),
        loadedLimit({ id: 3, limit_type: LimitType.CATEGORY, amount: '1250', name: null }, [2]),
      ];

      const result = service.calculateSpending(limits, new Map());

      expect(result.over_allocation).toEqual({ category_total: 2150, difference: 150 });
    });

    it('returns 0 percent instead of Infinity/NaN when a limit amount is 0', () => {
      const limits = [loadedLimit({ id: 1, limit_type: LimitType.CATEGORY, amount: '0', name: null }, [1])];
      const categoryTotals = new Map([[1, 40]]);

      const result = service.calculateSpending(limits, categoryTotals);

      expect(result.categories[0]).toMatchObject({ spent: 40, in_percent: 0 });
    });

    it('treats a category with no expenses in the period as zero spend', () => {
      const limits = [loadedLimit({ id: 1, limit_type: LimitType.CATEGORY, amount: '100', name: null }, [1])];

      const result = service.calculateSpending(limits, new Map());

      expect(result.categories[0]).toMatchObject({ spent: 0, in_percent: 0 });
    });
  });
});
