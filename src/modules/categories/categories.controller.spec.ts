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
          useValue: {
            getAll: jest.fn(),
            getOne: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            separateCategories: jest.fn(),
            moveToFront: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(CategoriesController);
    categoriesService = module.get(CategoriesService);
  });

  const req = { user: { id: 1 } } as any;

  describe('getAll', () => {
    it('fetches categories and delegates the income/expense split to the service', async () => {
      categoriesService.getAll.mockResolvedValue([{ id: 1 }] as any);
      categoriesService.separateCategories.mockReturnValue([[{ id: 1 }], []] as any);

      const result = await controller.getAll(req);

      expect(categoriesService.separateCategories).toHaveBeenCalledWith([{ id: 1 }]);
      expect(result).toEqual({ incomes: [{ id: 1 }], expenses: [] });
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
      expect(categoriesService.moveToFront).not.toHaveBeenCalled();
    });

    it('delegates the reordering to the service for an owned category', async () => {
      const category = { id: 2, user_id: 1, transaction_type: TransactionType.EXPENSE };
      categoriesService.getOne.mockResolvedValue(category as any);

      await controller.moveForward(req, 2);

      expect(categoriesService.moveToFront).toHaveBeenCalledWith(1, category);
    });
  });
});
