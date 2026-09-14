import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpacesService } from './spaces.service';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SPACE_LIMITS } from '@shared/constants';

describe('SpacesService', () => {
  let service: SpacesService;
  let spaceRepository: jest.Mocked<Repository<Space>>;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceRepositoryInTx: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let spaceMemberRepositoryInTx: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let spaceInviteRepositoryInTx: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let spaceQueryBuilder: {
    innerJoin: jest.Mock;
    innerJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    getOne: jest.Mock;
  };
  let memberQueryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    spaceQueryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    memberQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    spaceRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), delete: jest.fn() };
    spaceMemberRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), delete: jest.fn() };
    spaceInviteRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), delete: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Space) return spaceRepositoryInTx;
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        if (entity === SpaceInvite) return spaceInviteRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpacesService,
        {
          provide: getRepositoryToken(Space),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(spaceQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(SpaceMember),
          useValue: {
            find: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(memberQueryBuilder),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SpacesService);
    spaceRepository = module.get(getRepositoryToken(Space));
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
  });

  describe('create', () => {
    it('creates a personal space with no invites', async () => {
      const dto = { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 } as any;
      spaceRepositoryInTx.save.mockResolvedValue({ id: 10 });
      spaceRepository.findOne.mockResolvedValue({ id: 10, name: 'Personal' } as Space);

      const result = await service.create(1, dto);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(spaceRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 }),
      );
      expect(spaceMemberRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 10, user_id: 1, role: SpaceRole.OWNER }),
      );
      expect(spaceInviteRepositoryInTx.save).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 10, name: 'Personal' });
    });

    it('creates a group space and its inline invites', async () => {
      const dto = {
        name: 'Family',
        type: SpaceType.GROUP,
        currency_id: 1,
        invites: ['a@example.com', 'b@example.com'],
      } as any;
      spaceRepositoryInTx.save.mockResolvedValue({ id: 11 });
      spaceRepository.findOne.mockResolvedValue({ id: 11, name: 'Family' } as Space);

      await service.create(1, dto);

      expect(spaceInviteRepositoryInTx.save).toHaveBeenCalledWith([
        expect.objectContaining({ space_id: 11, email: 'a@example.com', role: SpaceRole.MEMBER }),
        expect.objectContaining({ space_id: 11, email: 'b@example.com', role: SpaceRole.MEMBER }),
      ]);
    });

    it('rejects invites on a personal space', async () => {
      const dto = { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1, invites: ['a@example.com'] } as any;

      await expect(service.create(1, dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects more invites than the pending-invite cap', async () => {
      const dto = {
        name: 'Family',
        type: SpaceType.GROUP,
        currency_id: 1,
        invites: Array.from({ length: SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE + 1 }, (_, i) => `u${i}@example.com`),
      } as any;

      await expect(service.create(1, dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('propagates a failure from inside the transaction', async () => {
      const dto = { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 } as any;
      spaceRepositoryInTx.save.mockRejectedValue(new Error('db unavailable'));

      await expect(service.create(1, dto)).rejects.toThrow('db unavailable');
    });
  });

  describe('getAllForUser', () => {
    it('returns an empty array when the user has no memberships', async () => {
      spaceMemberRepository.find.mockResolvedValue([]);

      const result = await service.getAllForUser(1);

      expect(result).toEqual([]);
      expect(spaceRepository.find).not.toHaveBeenCalled();
    });

    it('composes role, currency, and member_count for each space', async () => {
      spaceMemberRepository.find.mockResolvedValue([
        { space_id: 10, role: SpaceRole.OWNER } as SpaceMember,
        { space_id: 11, role: SpaceRole.MEMBER } as SpaceMember,
      ]);
      spaceRepository.find.mockResolvedValue([
        {
          id: 10,
          name: 'Personal',
          type: SpaceType.PERSONAL,
          currency: { id: 1, code: 'USD', name: 'US dollar' },
          created_at: new Date('2026-01-01'),
        } as Space,
        {
          id: 11,
          name: 'Family',
          type: SpaceType.GROUP,
          currency: { id: 1, code: 'USD', name: 'US dollar' },
          created_at: new Date('2026-01-02'),
        } as Space,
      ]);
      memberQueryBuilder.getRawMany.mockResolvedValue([
        { space_id: 10, count: '1' },
        { space_id: 11, count: '4' },
      ]);

      const result = await service.getAllForUser(1);

      expect(result).toEqual([
        expect.objectContaining({ id: 10, role: SpaceRole.OWNER, member_count: 1 }),
        expect.objectContaining({ id: 11, role: SpaceRole.MEMBER, member_count: 4 }),
      ]);
    });
  });

  describe('findOldestPersonalSpace', () => {
    it('returns the earliest-created personal space for the user', async () => {
      const space = { id: 5, type: SpaceType.PERSONAL } as Space;
      spaceQueryBuilder.getOne.mockResolvedValue(space);

      const result = await service.findOldestPersonalSpace(1);

      expect(spaceQueryBuilder.orderBy).toHaveBeenCalledWith('space.created_at', 'ASC');
      expect(result).toBe(space);
    });

    it('returns null when the user has no personal space', async () => {
      spaceQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.findOldestPersonalSpace(1);

      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('rejects deleting a user’s only remaining space', async () => {
      spaceMemberRepository.count.mockResolvedValue(1);

      await expect(service.remove(10, 1)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('deletes invites, members, and the space in order', async () => {
      spaceMemberRepository.count.mockResolvedValue(2);

      await service.remove(10, 1);

      expect(spaceInviteRepositoryInTx.delete).toHaveBeenCalledWith({ space_id: 10 });
      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith({ space_id: 10 });
      expect(spaceRepositoryInTx.delete).toHaveBeenCalledWith(10);

      const inviteCallOrder = spaceInviteRepositoryInTx.delete.mock.invocationCallOrder[0];
      const memberCallOrder = spaceMemberRepositoryInTx.delete.mock.invocationCallOrder[0];
      const spaceCallOrder = spaceRepositoryInTx.delete.mock.invocationCallOrder[0];
      expect(inviteCallOrder).toBeLessThan(memberCallOrder);
      expect(memberCallOrder).toBeLessThan(spaceCallOrder);
    });

    it('propagates a failure from inside the transaction', async () => {
      spaceMemberRepository.count.mockResolvedValue(2);
      spaceRepositoryInTx.delete.mockRejectedValue(new Error('db unavailable'));

      await expect(service.remove(10, 1)).rejects.toThrow('db unavailable');
    });
  });
});
