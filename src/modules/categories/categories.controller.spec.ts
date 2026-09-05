import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { ErrorMessages } from '@shared/error-messages';

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
            deleteOrArchive: jest.fn(),
            reorder: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get(CategoriesController);
    categoriesService = module.get(CategoriesService);
  });

  const req = { user: { id: 1 } } as any;

  describe('getAll', () => {
    it('delegates straight to the service', async () => {
      const view = { incomes: [], expenses: [], archived: [] };
      categoriesService.getAll.mockResolvedValue(view as any);

      const result = await controller.getAll(req);

      expect(categoriesService.getAll).toHaveBeenCalledWith(1);
      expect(result).toBe(view);
    });
  });

  describe('reorder', () => {
    it('delegates the ordered id list to the service', async () => {
      await controller.reorder(req, { category_ids: [3, 1, 2] });

      expect(categoriesService.reorder).toHaveBeenCalledWith(1, [3, 1, 2]);
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

  describe('remove', () => {
    it('rejects deleting a category owned by someone else', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, user_id: 2 } as any);

      await expect(controller.remove(req, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoriesService.deleteOrArchive).not.toHaveBeenCalled();
    });

    it('deletes or archives a category owned by the current user', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, user_id: 1 } as any);
      categoriesService.deleteOrArchive.mockResolvedValue({ archived: true });

      const result = await controller.remove(req, 1);

      expect(categoriesService.deleteOrArchive).toHaveBeenCalledWith(1);
      expect(result).toEqual({ archived: true });
    });
  });
});
