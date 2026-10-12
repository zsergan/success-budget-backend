import { Test, TestingModule } from '@nestjs/testing';

import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import type { CreateCategoryDto } from './dto/create-category.dto';
import { AppColor, CategoryIcon, TransactionType } from '@shared/enums';
import type { AuthedRequest } from '@shared/types';
import { buildCategory } from '@testing';

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

  const req: AuthedRequest = { user: { id: 1 } };
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
    const category = buildCategory({ id: 5, name: 'New' });
    categoriesService.update.mockResolvedValue(category);

    const result = await controller.update(req, spaceId, 5, { name: 'New' });

    expect(categoriesService.update).toHaveBeenCalledWith(1, spaceId, 5, { name: 'New' });
    expect(result).toBe(category);
  });

  it('create delegates with the caller and space', async () => {
    const dto: CreateCategoryDto = {
      name: 'Food',
      transaction_type: TransactionType.EXPENSE,
      icon: CategoryIcon.GROCERY,
      color: AppColor.EVERGREEN,
    };
    const category = buildCategory({ id: 5, ...dto });
    categoriesService.create.mockResolvedValue(category);

    const result = await controller.create(req, spaceId, dto);

    expect(categoriesService.create).toHaveBeenCalledWith(1, spaceId, dto);
    expect(result).toBe(category);
  });

  it('remove delegates to deleteOrArchive', async () => {
    categoriesService.deleteOrArchive.mockResolvedValue({ archived: true });

    const result = await controller.remove(req, spaceId, 5);

    expect(categoriesService.deleteOrArchive).toHaveBeenCalledWith(1, spaceId, 5);
    expect(result).toEqual({ archived: true });
  });
});
