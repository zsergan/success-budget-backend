import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LimitsService } from './limits.service';
import { Limit } from '../../entities/limit.entity';
import { LimitType } from '../../shared/enums';

describe('LimitsService', () => {
  let service: LimitsService;
  let repository: jest.Mocked<Repository<Limit>>;
  let queryBuilder: Record<string, jest.Mock>;

  beforeEach(async () => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
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
  });

  describe('update', () => {
    it('nulls category_id and switches to OTHERS when no category is provided', async () => {
      await service.update(1, { amount: 200 } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ category_id: null, limit_type: LimitType.OTHERS }),
      );
    });

    it('keeps category_id and switches to CATEGORY when a category is provided', async () => {
      await service.update(1, { amount: 200, category_id: 7 } as any);

      expect(repository.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ category_id: 7, limit_type: LimitType.CATEGORY }),
      );
    });
  });

  describe('getAll', () => {
    it('scopes limits to the user', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.getAll(3);

      expect(queryBuilder.where).toHaveBeenCalledWith('limit.user_id = :userId', { userId: 3 });
    });
  });
});
