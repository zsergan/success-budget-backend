import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpaceInvitesService } from './space-invites.service';
import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SPACE_LIMITS } from '@shared/constants';

describe('SpaceInvitesService', () => {
  let service: SpaceInvitesService;
  let spaceInviteRepository: jest.Mocked<Repository<SpaceInvite>>;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceInviteRepositoryInTx: { update: jest.Mock };
  let spaceMemberRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let spaceRepositoryInTx: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    spaceInviteRepositoryInTx = { update: jest.fn() };
    spaceMemberRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn() };
    spaceRepositoryInTx = { findOne: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === SpaceInvite) return spaceInviteRepositoryInTx;
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        if (entity === Space) return spaceRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    };
    dataSource = { transaction: jest.fn((callback) => callback(manager)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceInvitesService,
        {
          provide: getRepositoryToken(SpaceInvite),
          useValue: {
            create: jest.fn((entity) => entity),
            save: jest.fn(),
            find: jest.fn(),
            findOne: jest.fn(),
            update: jest.fn(),
          },
        },
        { provide: getRepositoryToken(SpaceMember), useValue: { count: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SpaceInvitesService);
    spaceInviteRepository = module.get(getRepositoryToken(SpaceInvite));
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
  });

  describe('create', () => {
    it('rejects inviting into a personal space', async () => {
      const space = { id: 1, type: SpaceType.PERSONAL } as Space;

      await expect(service.create(space, 'a@example.com')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, 400),
      );
      expect(spaceInviteRepository.save).not.toHaveBeenCalled();
    });

    it('rejects once the active-invite cap is reached', async () => {
      const space = { id: 1, type: SpaceType.GROUP } as Space;
      spaceInviteRepository.find.mockResolvedValue(
        Array.from({ length: SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE }, () => ({}) as SpaceInvite),
      );

      await expect(service.create(space, 'a@example.com')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, 400),
      );
    });

    it('creates the invite on the happy path', async () => {
      const space = { id: 1, type: SpaceType.GROUP } as Space;
      spaceInviteRepository.find.mockResolvedValue([]);
      spaceInviteRepository.save.mockImplementation(async (entity) => entity as SpaceInvite);

      const result = await service.create(space, 'a@example.com');

      expect(spaceInviteRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 1, email: 'a@example.com', role: SpaceRole.MEMBER }),
      );
      expect(result).toMatchObject({ email: 'a@example.com' });
    });
  });

  describe('revoke', () => {
    it('rejects an unknown or already-resolved invite', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(null);

      await expect(service.revoke(1, 10)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });

    it('stamps revoked_at on the happy path', async () => {
      spaceInviteRepository.findOne.mockResolvedValue({ id: 1 } as SpaceInvite);

      await service.revoke(1, 10);

      expect(spaceInviteRepository.update).toHaveBeenCalledWith(1, { revoked_at: expect.any(Date) });
    });
  });

  describe('accept', () => {
    it('rejects when no active invite matches the code and caller email', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(null);

      await expect(service.accept(1, 'a@example.com', '123456')).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
    });

    it('rejects when the space has reached its member cap', async () => {
      spaceInviteRepository.findOne.mockResolvedValue({ id: 1, space_id: 10, role: SpaceRole.MEMBER } as SpaceInvite);
      spaceMemberRepository.count.mockResolvedValue(SPACE_LIMITS.MAX_MEMBERS_PER_SPACE);

      await expect(service.accept(1, 'a@example.com', '123456')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_MEMBER_LIMIT_REACHED, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates the membership and stamps accepted_at in one transaction', async () => {
      spaceInviteRepository.findOne.mockResolvedValue({ id: 1, space_id: 10, role: SpaceRole.MEMBER } as SpaceInvite);
      spaceMemberRepository.count.mockResolvedValue(1);
      const space = { id: 10 } as Space;
      spaceRepositoryInTx.findOne.mockResolvedValue(space);

      const result = await service.accept(2, 'a@example.com', '123456');

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 10, user_id: 2, role: SpaceRole.MEMBER }),
      );
      expect(spaceInviteRepositoryInTx.update).toHaveBeenCalledWith(1, { accepted_at: expect.any(Date) });
      expect(result).toBe(space);
    });
  });
});
