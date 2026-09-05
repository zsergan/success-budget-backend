import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { LimitsService } from './limits.service';
import { Limit } from '@entities/limit.entity';
import { LimitType, TransactionType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';

describe('LimitsService', () => {
  let service: LimitsService;
  let repository: jest.Mocked<Repository<Limit>>;
  let queryBuilder: Record<string, jest.Mock>;
  let relationBuilder: Record<string, jest.Mock>;

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
      ],
    }).compile();

    service = module.get(LimitsService);
    repository = module.get(getRepositoryToken(Limit));
  });

  describe('create', () => {
    it('creates a total (monthly) limit when no categories are given', async () => {
      repository.create.mockImplementation((v) => v as Limit);
      repository.save.mockResolvedValue({ id: 1 } as Limit);
      repository.findOne.mockResolvedValue({ id: 1, categories: [] } as any);

      await service.create(1, { amount: 2000 } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, limit_type: LimitType.OTHERS, name: null }),
      );
      expect(relationBuilder.add).not.toHaveBeenCalled();
    });

    it('creates a single-category limit and links it', async () => {
      repository.create.mockImplementation((v) => v as Limit);
      repository.save.mockResolvedValue({ id: 1 } as Limit);
      repository.findOne.mockResolvedValue({ id: 1, categories: [{ id: 4 }] } as any);

      await service.create(1, { category_ids: [4], amount: 100 } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, limit_type: LimitType.CATEGORY, name: null }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([4]);
    });

    it('creates a named group limit covering multiple categories', async () => {
      repository.create.mockImplementation((v) => v as Limit);
      repository.save.mockResolvedValue({ id: 1 } as Limit);
      repository.findOne.mockResolvedValue({ id: 1, categories: [{ id: 4 }, { id: 5 }] } as any);

      await service.create(1, { category_ids: [4, 5], name: 'Fun', amount: 220 } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ limit_type: LimitType.CATEGORY, name: 'Fun' }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([4, 5]);
    });

    it('rejects a group with more than one category and no name', async () => {
      await expect(service.create(1, { category_ids: [4, 5], amount: 220 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a category already claimed by another limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);

      await expect(service.create(1, { category_ids: [4], amount: 100 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects a second monthly total limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);

      await expect(service.create(1, { amount: 2000 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates only the amount when categories are not touched', async () => {
      const current = { id: 1, name: null, categories: [{ id: 4 }] } as Limit;

      await service.update(1, 1, current, { amount: 200 } as any);

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, { amount: 200 });
      expect(relationBuilder.add).not.toHaveBeenCalled();
      expect(relationBuilder.remove).not.toHaveBeenCalled();
    });

    it('switches a category limit to a monthly total limit', async () => {
      const current = { id: 1, name: null, categories: [{ id: 4 }] } as Limit;

      await service.update(1, 1, current, { category_ids: [] } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ limit_type: LimitType.OTHERS, name: null }),
      );
      expect(relationBuilder.remove).toHaveBeenCalledWith([4]);
      expect(relationBuilder.add).not.toHaveBeenCalled();
    });

    it('switches a total limit to a single-category limit', async () => {
      const current = { id: 1, name: null, categories: [] } as Limit;

      await service.update(1, 1, current, { category_ids: [7] } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ limit_type: LimitType.CATEGORY, name: null }),
      );
      expect(relationBuilder.add).toHaveBeenCalledWith([7]);
      expect(relationBuilder.remove).not.toHaveBeenCalled();
    });

    it('rejects turning a limit into an unnamed group', async () => {
      const current = { id: 1, name: null, categories: [{ id: 4 }] } as Limit;

      await expect(service.update(1, 1, current, { category_ids: [4, 5] } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_NAME_REQUIRED, 400),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('keeps the existing name when growing an already-named group', async () => {
      const current = { id: 1, name: 'Fun', categories: [{ id: 4 }, { id: 5 }] } as Limit;

      await service.update(1, 1, current, { category_ids: [4, 5, 6] } as any);

      expect(repository.update).toHaveBeenCalledWith({ id: 1 }, expect.objectContaining({ name: 'Fun' }));
      expect(relationBuilder.add).toHaveBeenCalledWith([6]);
    });

    it('rejects switching to a category already claimed by another limit', async () => {
      queryBuilder.getCount.mockResolvedValue(1);
      const current = { id: 1, name: null, categories: [{ id: 4 }] } as Limit;

      await expect(service.update(1, 1, current, { category_ids: [9] } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the limit by id', async () => {
      await service.remove(1);

      expect(repository.delete).toHaveBeenCalledWith(1);
    });
  });

  describe('getAll', () => {
    it('scopes limits to the user', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(3);

      expect(queryBuilder.where).toHaveBeenCalledWith('limit.user_id = :userId', { userId: 3 });
      expect(queryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('limit.categories', 'categories');
    });
  });

  describe('calculateSpending', () => {
    it('tracks the monthly total independently of category limits', () => {
      const limits = [
        { id: 1, limit_type: LimitType.OTHERS, amount: 2000, name: null, categories: [] },
        { id: 2, limit_type: LimitType.CATEGORY, amount: 400, name: null, categories: [{ id: 10 }] },
      ] as any;
      const transactions = [
        { category_id: 10, transaction_type: TransactionType.EXPENSE, amount: 350 },
        { category_id: 99, transaction_type: TransactionType.EXPENSE, amount: 50 },
        { category_id: 10, transaction_type: TransactionType.INCOME, amount: 1000 },
      ] as any;

      const result = service.calculateSpending(limits, transactions);

      // total = ALL expenses (350 + 50), not just the unclaimed 50
      expect(result.total).toMatchObject({ id: 1, spent: 400, in_percent: 20 });
      expect(result.categories[0]).toMatchObject({ id: 2, spent: 350, in_percent: 87 });
      expect(result.over_allocation).toBeNull();
    });

    it('sums spend across every category in a group limit', () => {
      const limits = [
        { id: 1, limit_type: LimitType.CATEGORY, amount: 220, name: 'Fun', categories: [{ id: 1 }, { id: 2 }] },
      ] as any;
      const transactions = [
        { category_id: 1, transaction_type: TransactionType.EXPENSE, amount: 80 },
        { category_id: 2, transaction_type: TransactionType.EXPENSE, amount: 40 },
      ] as any;

      const result = service.calculateSpending(limits, transactions);

      expect(result.categories[0]).toMatchObject({ spent: 120, in_percent: 54 });
    });

    it('flags when category limits sum above the monthly total, as a note not an error', () => {
      const limits = [
        { id: 1, limit_type: LimitType.OTHERS, amount: 2000, name: null, categories: [] },
        { id: 2, limit_type: LimitType.CATEGORY, amount: 900, name: null, categories: [{ id: 1 }] },
        { id: 3, limit_type: LimitType.CATEGORY, amount: 1250, name: null, categories: [{ id: 2 }] },
      ] as any;

      const result = service.calculateSpending(limits, []);

      expect(result.over_allocation).toEqual({ category_total: 2150, difference: 150 });
    });

    it('returns 0 percent instead of Infinity/NaN when a limit amount is 0', () => {
      const limits = [{ id: 1, limit_type: LimitType.CATEGORY, amount: 0, name: null, categories: [{ id: 1 }] }] as any;
      const transactions = [{ category_id: 1, transaction_type: TransactionType.EXPENSE, amount: 40 }] as any;

      const result = service.calculateSpending(limits, transactions);

      expect(result.categories[0]).toMatchObject({ spent: 40, in_percent: 0 });
    });
  });
});
