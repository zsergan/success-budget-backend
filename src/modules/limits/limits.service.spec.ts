import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { LimitsService } from './limits.service';
import { Limit } from '../../entities/limit.entity';
import { LimitType, TransactionType } from '../../shared/enums';
import { ErrorMessages } from '../../shared/error-messages';

describe('LimitsService', () => {
  let service: LimitsService;
  let repository: jest.Mocked<Repository<Limit>>;
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
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
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(LimitsService);
    repository = module.get(getRepositoryToken(Limit));
  });

  describe('create', () => {
    it('marks a limit with a category as a CATEGORY limit', async () => {
      const dto = { category_id: 4, amount: 100 } as any;
      repository.create.mockImplementation((v) => v as Limit);
      repository.save.mockImplementation(async (v) => v as Limit);

      await service.create(1, dto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, limit_type: LimitType.CATEGORY }),
      );
    });

    it('marks a limit without a category as an OTHERS limit', async () => {
      const dto = { amount: 100 } as any;
      repository.create.mockImplementation((v) => v as Limit);
      repository.save.mockImplementation(async (v) => v as Limit);

      await service.create(1, dto);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, limit_type: LimitType.OTHERS }),
      );
    });

    it('rejects a duplicate category limit before creating', async () => {
      queryBuilder.getMany.mockResolvedValue([{ category_id: 4 }]);

      await expect(service.create(1, { category_id: 4, amount: 100 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate "others" limit before creating', async () => {
      queryBuilder.getMany.mockResolvedValue([{ category_id: null }]);

      await expect(service.create(1, { amount: 100 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('nulls category_id and switches to OTHERS when no category is provided', async () => {
      await service.update(1, 1, 5, { amount: 200 } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ category_id: null, limit_type: LimitType.OTHERS }),
      );
    });

    it('keeps category_id and switches to CATEGORY when a category is provided', async () => {
      await service.update(1, 1, null, { amount: 200, category_id: 7 } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ category_id: 7, limit_type: LimitType.CATEGORY }),
      );
    });

    it('skips the duplicate check when the category does not change', async () => {
      await service.update(1, 1, 7, { amount: 200, category_id: 7 } as any);

      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });

    it('rejects switching to a category that already has a limit', async () => {
      queryBuilder.getMany.mockResolvedValue([{ category_id: 9 }]);

      await expect(service.update(1, 1, 7, { amount: 200, category_id: 9 } as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.LIMIT_EXISTS, 400),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('scopes limits to the user', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(3);

      expect(queryBuilder.where).toHaveBeenCalledWith('limit.user_id = :userId', { userId: 3 });
    });
  });

  describe('calculateSpending', () => {
    it('computes spent amounts and percentages per limit and overall', () => {
      const limits = [
        { id: 1, user_id: 1, category_id: 1, amount: 100 },
        { id: 2, user_id: 1, category_id: null, amount: 50 },
      ] as any;
      const transactions = [
        { category_id: 1, transaction_type: TransactionType.EXPENSE, amount: 40 },
        { category_id: 2, transaction_type: TransactionType.EXPENSE, amount: 10 },
        { category_id: 1, transaction_type: TransactionType.INCOME, amount: 1000 },
      ] as any;

      const result = service.calculateSpending(limits, transactions);

      expect(result.limits[0]).toMatchObject({ spent: 40, in_percent: 40 });
      expect(result.limits[1]).toMatchObject({ spent: 10, in_percent: 20 });
      expect(result.overall).toMatchObject({ spent: 50, sum: 150, in_percent: 33 });
    });

    it('returns 0 percent instead of Infinity/NaN when a limit amount is 0', () => {
      const limits = [{ id: 1, user_id: 1, category_id: 1, amount: 0 }] as any;
      const transactions = [{ category_id: 1, transaction_type: TransactionType.EXPENSE, amount: 40 }] as any;

      const result = service.calculateSpending(limits, transactions);

      expect(result.limits[0]).toMatchObject({ spent: 40, in_percent: 0 });
      expect(result.overall).toMatchObject({ spent: 40, sum: 0, in_percent: 0 });
    });
  });
});
