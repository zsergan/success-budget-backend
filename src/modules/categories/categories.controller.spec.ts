import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { SpaceMembersService } from '@modules/spaces/space-members.service';
import { ErrorMessages } from '@shared/error-messages';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let categoriesService: jest.Mocked<CategoriesService>;
  let spaceMembersService: jest.Mocked<SpaceMembersService>;

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
        { provide: SpaceMembersService, useValue: { assertMembership: jest.fn() } },
      ],
    }).compile();

    controller = module.get(CategoriesController);
    categoriesService = module.get(CategoriesService);
    spaceMembersService = module.get(SpaceMembersService);
  });

  const req = { user: { id: 1 } } as any;
  const spaceId = 10;

  describe('getAll', () => {
    it('delegates straight to the service', async () => {
      const view = { incomes: [], expenses: [], archived: [] };
      categoriesService.getAll.mockResolvedValue(view as any);

      const result = await controller.getAll(req, spaceId);

      expect(spaceMembersService.assertMembership).toHaveBeenCalledWith(spaceId, 1);
      expect(categoriesService.getAll).toHaveBeenCalledWith(spaceId);
      expect(result).toBe(view);
    });
  });

  describe('reorder', () => {
    it('delegates the ordered id list to the service', async () => {
      await controller.reorder(req, spaceId, { category_ids: [3, 1, 2] });

      expect(categoriesService.reorder).toHaveBeenCalledWith(spaceId, [3, 1, 2]);
    });
  });

  describe('update', () => {
    it('rejects updating a category that belongs to a different space', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(controller.update(req, spaceId, 1, {} as any)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoriesService.update).not.toHaveBeenCalled();
    });

    it('updates a category that belongs to the space', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);

      await controller.update(req, spaceId, 1, { name: 'New' } as any);

      expect(categoriesService.update).toHaveBeenCalledWith(1, { name: 'New' });
    });
  });

  describe('create', () => {
    it('creates a category for the space', async () => {
      categoriesService.create.mockResolvedValue({ id: 5 } as any);

      const result = await controller.create(req, spaceId, { name: 'Food' } as any);

      expect(categoriesService.create).toHaveBeenCalledWith(spaceId, { name: 'Food' });
      expect(result).toEqual({ id: 5 });
    });
  });

  describe('remove', () => {
    it('rejects deleting a category that belongs to a different space', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, space_id: 20 } as any);

      await expect(controller.remove(req, spaceId, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_CATEGORY, 403),
      );
      expect(categoriesService.deleteOrArchive).not.toHaveBeenCalled();
    });

    it('deletes or archives a category that belongs to the space', async () => {
      categoriesService.getOne.mockResolvedValue({ id: 1, space_id: spaceId } as any);
      categoriesService.deleteOrArchive.mockResolvedValue({ archived: true });

      const result = await controller.remove(req, spaceId, 1);

      expect(categoriesService.deleteOrArchive).toHaveBeenCalledWith(1);
      expect(result).toEqual({ archived: true });
    });
  });
});
