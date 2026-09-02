import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CategoriesService } from './categories.service';
import { Category } from '@entities/category.entity';
import { TransactionType } from '@shared/enums';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let repository: jest.Mocked<Repository<Category>>;
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: getRepositoryToken(Category),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(CategoriesService);
    repository = module.get(getRepositoryToken(Category));
  });

  describe('getAll', () => {
    it('scopes to the user and orders by sort ascending', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(2);

      expect(queryBuilder.where).toHaveBeenCalledWith('category.user_id = :userId', { userId: 2 });
      expect(queryBuilder.orderBy).toHaveBeenCalledWith('category.sort', 'ASC');
    });
  });

  describe('initiateCategories', () => {
    it('stamps every category with the given user id', async () => {
      const categories = [{ name: 'Food' }, { name: 'Rent' }] as any[];
      repository.save.mockResolvedValue([] as any);

      await service.initiateCategories(9, categories);

      expect(repository.save).toHaveBeenCalledWith([
        { name: 'Food', user_id: 9 },
        { name: 'Rent', user_id: 9 },
      ]);
    });
  });

  describe('update', () => {
    it('merges the update onto the existing category', async () => {
      repository.findOne.mockResolvedValue({ id: 1, name: 'Old', sort: 1 } as Category);
      repository.save.mockResolvedValue({} as Category);

      await service.update(1, { name: 'New' } as any);

      expect(repository.save).toHaveBeenCalledWith({ id: 1, name: 'New', sort: 1 });
    });
  });

  describe('create', () => {
    it('saves a new category for the user', async () => {
      repository.save.mockResolvedValue({} as Category);

      await service.create(9, { name: 'Food' } as any);

      expect(repository.save).toHaveBeenCalledWith({ name: 'Food', user_id: 9 });
    });
  });

  describe('separateCategories', () => {
    it('splits categories into incomes and expenses', () => {
      const categories = [
        { id: 1, transaction_type: TransactionType.INCOME },
        { id: 2, transaction_type: TransactionType.EXPENSE },
        { id: 3, transaction_type: TransactionType.INCOME },
      ] as any;

      const [incomes, expenses] = service.separateCategories(categories);

      expect(incomes.map((c: any) => c.id)).toEqual([1, 3]);
      expect(expenses.map((c: any) => c.id)).toEqual([2]);
    });
  });

  describe('moveToFront', () => {
    it('moves an expense category to the front of the expense group with prefix 200', async () => {
      queryBuilder.getMany.mockResolvedValue([
        { id: 1, user_id: 1, transaction_type: TransactionType.EXPENSE },
        { id: 2, user_id: 1, transaction_type: TransactionType.EXPENSE },
        { id: 3, user_id: 1, transaction_type: TransactionType.EXPENSE },
      ]);
      repository.save.mockResolvedValue([] as any);

      await service.moveToFront(1, { id: 2, user_id: 1, transaction_type: TransactionType.EXPENSE } as any);

      expect(repository.save).toHaveBeenCalledWith([
        expect.objectContaining({ id: 2, sort: 200 }),
        expect.objectContaining({ id: 1, sort: 201 }),
        expect.objectContaining({ id: 3, sort: 202 }),
      ]);
    });

    it('moves an income category to the front of the income group with prefix 100', async () => {
      queryBuilder.getMany.mockResolvedValue([
        { id: 1, user_id: 1, transaction_type: TransactionType.INCOME },
        { id: 2, user_id: 1, transaction_type: TransactionType.INCOME },
      ]);
      repository.save.mockResolvedValue([] as any);

      await service.moveToFront(1, { id: 1, user_id: 1, transaction_type: TransactionType.INCOME } as any);

      expect(repository.save).toHaveBeenCalledWith([
        expect.objectContaining({ id: 1, sort: 100 }),
        expect.objectContaining({ id: 2, sort: 101 }),
      ]);
    });
  });
});
