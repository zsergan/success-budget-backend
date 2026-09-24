import { Test, TestingModule } from '@nestjs/testing';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

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
  const spaceId = 10;

  it('getAll delegates with the caller and space', async () => {
    const view = { incomes: [], expenses: [], archived: [] };
    categoriesService.getAll.mockResolvedValue(view);

    const result = await controller.getAll(req, spaceId);

    expect(categoriesService.getAll).toHaveBeenCalledWith(1, spaceId);
    expect(result).toBe(view);
  });

  it('reorder delegates the ordered id list', async () => {
    await controller.reorder(req, spaceId, { category_ids: [3, 1, 2] });

    expect(categoriesService.reorder).toHaveBeenCalledWith(1, spaceId, [3, 1, 2]);
  });

  it('update delegates with the caller, space and category id', async () => {
    categoriesService.update.mockResolvedValue({ id: 5 } as any);

    const result = await controller.update(req, spaceId, 5, { name: 'New' } as any);

    expect(categoriesService.update).toHaveBeenCalledWith(1, spaceId, 5, { name: 'New' });
    expect(result).toEqual({ id: 5 });
  });

  it('create delegates with the caller and space', async () => {
    categoriesService.create.mockResolvedValue({ id: 5 } as any);

    const result = await controller.create(req, spaceId, { name: 'Food' } as any);

    expect(categoriesService.create).toHaveBeenCalledWith(1, spaceId, { name: 'Food' });
    expect(result).toEqual({ id: 5 });
  });

  it('remove delegates to deleteOrArchive', async () => {
    categoriesService.deleteOrArchive.mockResolvedValue({ archived: true });

    const result = await controller.remove(req, spaceId, 5);

    expect(categoriesService.deleteOrArchive).toHaveBeenCalledWith(1, spaceId, 5);
    expect(result).toEqual({ archived: true });
  });
});
