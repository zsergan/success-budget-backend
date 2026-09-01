import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConfirmationCodesService } from './confirmation-codes.service';
import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { ConfirmationType } from '../../shared/enums';

describe('ConfirmationCodesService', () => {
  let service: ConfirmationCodesService;
  let repository: jest.Mocked<Repository<ConfirmationCode>>;

  beforeEach(async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfirmationCodesService,
        {
          provide: getRepositoryToken(ConfirmationCode),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
            increment: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
      ],
    }).compile();

    service = module.get(ConfirmationCodesService);
    repository = module.get(getRepositoryToken(ConfirmationCode));
  });

  describe('getOne', () => {
    it('looks up a non-expired code for the user and type', async () => {
      const code = { id: 1, confirmation_code: '1234' } as ConfirmationCode;
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue(code);

      const result = await service.getOne(1, ConfirmationType.EMAIL);

      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 1, confirmation_type: ConfirmationType.EMAIL });
      expect(result).toBe(code);
    });
  });

  describe('create', () => {
    it('creates a code that expires 10 minutes from now', async () => {
      const dto = { user_id: 1, confirmation_code: '1234', confirmation_type: ConfirmationType.EMAIL };
      const before = Date.now();

      await service.create(dto);

      expect(repository.create).toHaveBeenCalled();
      const created = repository.create.mock.calls[0][0] as Partial<ConfirmationCode>;
      expect(created.expired_at.getTime() - before).toBeGreaterThanOrEqual(1000 * 60 * 10 - 1000);
      expect(repository.save).toHaveBeenCalled();
    });
  });

  describe('ensureCode', () => {
    it('does nothing when a non-expired code already exists', async () => {
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue({ id: 1 } as ConfirmationCode);

      await service.ensureCode(1, ConfirmationType.EMAIL);

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('creates a new code when none exists yet', async () => {
      const queryBuilder = repository.createQueryBuilder();
      (queryBuilder.getOne as jest.Mock).mockResolvedValue(null);

      await service.ensureCode(1, ConfirmationType.EMAIL);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 1, confirmation_type: ConfirmationType.EMAIL }),
      );
      expect(repository.save).toHaveBeenCalled();
    });
  });

  describe('incrementAttempts', () => {
    it('atomically increments the attempts counter by id', async () => {
      await service.incrementAttempts(7);

      expect(repository.increment).toHaveBeenCalledWith({ id: 7 }, 'attempts', 1);
    });
  });

  describe('expire', () => {
    it('does nothing when no matching code exists', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.expire(1, ConfirmationType.EMAIL);

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('sets expired_at back to created_at for an existing code', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      repository.findOne.mockResolvedValue({ id: 5, created_at: createdAt } as ConfirmationCode);

      await service.expire(1, ConfirmationType.EMAIL);

      expect(repository.update).toHaveBeenCalledWith(5, { expired_at: createdAt });
    });
  });
});
