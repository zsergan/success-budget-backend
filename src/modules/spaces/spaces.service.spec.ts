import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { SpacesService } from './spaces.service';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { IdempotencyService } from '@modules/idempotency/idempotency.service';
import { NO_SPACE_ID } from '@entities/idempotency-key.entity';
import { SpaceInviteDelivery } from './space-invite-delivery';
import { RetryAfterException } from '@shared/retry-after.exception';
import { Space } from '@entities/space.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { Category } from '@entities/category.entity';
import { SpaceInviteEmailStatus, SpaceRole, SpaceType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SPACE_LIMITS } from '@shared/constants';
import type { CreateSpaceDto } from './dto/create-space.dto';
import { buildCurrency, buildSpace, buildSpaceMember } from '@testing';

describe('SpacesService', () => {
  let service: SpacesService;
  let spaceRepository: jest.Mocked<Repository<Space>>;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceRepositoryInTx: { create: jest.Mock; save: jest.Mock; delete: jest.Mock; findOne: jest.Mock };
  let spaceMemberRepositoryInTx: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let spaceInviteRepositoryInTx: { insert: jest.Mock };
  let idempotencyService: { run: jest.Mock };
  let delivery: { assertCanSchedule: jest.Mock; recordScheduled: jest.Mock; deliverSoon: jest.Mock };
  let categoryRepositoryInTx: { save: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let manager: EntityManager;
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership' | 'lockMembers'>>;
  let memberQueryBuilder: {
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  beforeEach(async () => {
    memberQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    spaceRepositoryInTx = {
      create: jest.fn((entity) => entity),
      save: jest.fn(),
      delete: jest.fn(),
      findOne: jest.fn(),
    };
    spaceMemberRepositoryInTx = { create: jest.fn((entity) => entity), save: jest.fn(), delete: jest.fn() };
    spaceInviteRepositoryInTx = {
      insert: jest.fn(async (rows: unknown[]) => ({ identifiers: rows.map((_row, index) => ({ id: 500 + index })) })),
    };
    delivery = { assertCanSchedule: jest.fn(), recordScheduled: jest.fn(), deliverSoon: jest.fn() };
    idempotencyService = { run: jest.fn((_manager, _request, work: () => unknown) => work()) };
    categoryRepositoryInTx = { save: jest.fn() };
    manager = {
      getRepository: jest.fn((entity) => {
        if (entity === Space) return spaceRepositoryInTx;
        if (entity === SpaceMember) return spaceMemberRepositoryInTx;
        if (entity === SpaceInvite) return spaceInviteRepositoryInTx;
        if (entity === Category) return categoryRepositoryInTx;
        throw new Error(`Unexpected entity: ${entity}`);
      }),
    } as unknown as EntityManager;
    dataSource = {
      transaction: jest.fn((...args: unknown[]) => (args[args.length - 1] as (m: unknown) => unknown)(manager)),
    };
    spaceAccessService = {
      assertMembership: jest.fn().mockResolvedValue(buildSpaceMember()),
      lockMembers: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpacesService,
        {
          provide: getRepositoryToken(Space),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
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
        { provide: SpaceAccessService, useValue: spaceAccessService },
        { provide: IdempotencyService, useValue: idempotencyService },
        { provide: SpaceInviteDelivery, useValue: delivery },
      ],
    }).compile();

    service = module.get(SpacesService);
    spaceRepository = module.get(getRepositoryToken(Space));
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
  });

  describe('create', () => {
    it('creates a personal space with no invites', async () => {
      const dto: CreateSpaceDto = { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 };
      spaceRepositoryInTx.save.mockResolvedValue(buildSpace({ id: 10 }));
      spaceRepositoryInTx.findOne.mockResolvedValue(
        buildSpace({
          id: 10,
          name: 'Personal',
          currency: buildCurrency({ id: 1, code: 'USD', name: 'US Dollar' }),
        }),
      );

      const result = await service.create(1, dto);

      expect(dataSource.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
      expect(idempotencyService.run).not.toHaveBeenCalled();
      expect(spaceRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 }),
      );
      expect(spaceMemberRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 10, user_id: 1, role: SpaceRole.OWNER }),
      );
      expect(categoryRepositoryInTx.save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ space_id: 10, name: 'Initial balance', is_system: 1 })]),
      );
      expect(categoryRepositoryInTx.save.mock.calls[0][0]).toHaveLength(21);
      expect(spaceInviteRepositoryInTx.insert).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 10, name: 'Personal' });
    });

    it('creates a group space and its inline invites', async () => {
      const dto: CreateSpaceDto = {
        name: 'Family',
        type: SpaceType.GROUP,
        currency_id: 1,
        invites: ['a@example.com', 'b@example.com'],
      };
      spaceRepositoryInTx.save.mockResolvedValue(buildSpace({ id: 11, name: 'Family', type: SpaceType.GROUP }));
      spaceRepositoryInTx.findOne.mockResolvedValue(
        buildSpace({
          id: 11,
          name: 'Family',
          currency: buildCurrency({ id: 1, code: 'USD', name: 'US Dollar' }),
        }),
      );

      await service.create(1, dto);

      const queued = {
        role: SpaceRole.MEMBER,
        token_nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        email_status: SpaceInviteEmailStatus.QUEUED,
        email_next_attempt_at: expect.any(Date),
      };
      expect(spaceInviteRepositoryInTx.insert).toHaveBeenCalledWith([
        expect.objectContaining({ space_id: 11, email: 'a@example.com', ...queued }),
        expect.objectContaining({ space_id: 11, email: 'b@example.com', ...queued }),
      ]);
      const [rows] = spaceInviteRepositoryInTx.insert.mock.calls[0] as [SpaceInvite[]];
      expect(rows[0].token_nonce).not.toBe(rows[1].token_nonce);
      expect(delivery.assertCanSchedule).toHaveBeenCalledWith(
        expect.anything(),
        { senderId: 1, spaceId: null, emails: ['a@example.com', 'b@example.com'] },
        expect.any(Date),
      );
      expect(delivery.recordScheduled).toHaveBeenCalledWith(
        expect.anything(),
        1,
        [
          expect.objectContaining({ id: 500, email: 'a@example.com' }),
          expect.objectContaining({ id: 501, email: 'b@example.com' }),
        ],
        expect.any(Date),
      );
      expect(delivery.deliverSoon).toHaveBeenCalledWith([500, 501]);
      expect(delivery.deliverSoon.mock.invocationCallOrder[0]).toBeGreaterThan(
        dataSource.transaction.mock.invocationCallOrder[0],
      );
      expect(categoryRepositoryInTx.save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ space_id: 11, name: 'Initial balance', is_system: 1 })]),
      );
    });

    it('stores each address once, trimmed and lower-cased, and counts the limit after that', async () => {
      const invites = Array.from({ length: SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE }, (_, i) => `u${i}@example.com`);
      spaceRepositoryInTx.save.mockResolvedValue(buildSpace({ id: 11, type: SpaceType.GROUP }));
      spaceRepositoryInTx.findOne.mockResolvedValue(buildSpace({ id: 11, currency: buildCurrency() }));

      await service.create(1, {
        name: 'Family',
        type: SpaceType.GROUP,
        currency_id: 1,
        invites: [...invites, 'U0@Example.COM', ' u1@example.com '],
      });

      const [rows] = spaceInviteRepositoryInTx.insert.mock.calls[0] as [SpaceInvite[]];
      expect(rows.map((row) => row.email)).toEqual(invites);
    });

    it('runs the whole creation under the Idempotency-Key, scoped to the user', async () => {
      const dto: CreateSpaceDto = { name: 'Family', type: SpaceType.GROUP, currency_id: 1, invites: ['a@example.com'] };
      const stored = { id: 11, name: 'Family' };
      idempotencyService.run.mockResolvedValue(stored);

      await expect(service.create(1, dto, { idempotencyKey: 'key-1' })).resolves.toBe(stored);

      expect(idempotencyService.run).toHaveBeenCalledWith(
        expect.anything(),
        { userId: 1, spaceId: NO_SPACE_ID, operation: 'spaces.create', key: 'key-1', payload: dto },
        expect.any(Function),
      );
      expect(spaceRepositoryInTx.save).not.toHaveBeenCalled();
      expect(spaceInviteRepositoryInTx.insert).not.toHaveBeenCalled();
      expect(delivery.deliverSoon).toHaveBeenCalledWith([]);
    });

    it('creates nothing when the inline invitations exceed a sending limit', async () => {
      spaceRepositoryInTx.save.mockResolvedValue(buildSpace({ id: 11, type: SpaceType.GROUP }));
      delivery.assertCanSchedule.mockRejectedValue(new RetryAfterException('SPACE_INVITE_RATE_LIMITED', 30));

      await expect(
        service.create(1, { name: 'Family', type: SpaceType.GROUP, currency_id: 1, invites: ['a@example.com'] }),
      ).rejects.toMatchObject({ retryAfterSeconds: 30 });
      expect(spaceInviteRepositoryInTx.insert).not.toHaveBeenCalled();
      expect(delivery.deliverSoon).not.toHaveBeenCalled();
    });

    it('rejects invites on a personal space', async () => {
      const dto: CreateSpaceDto = {
        name: 'Personal',
        type: SpaceType.PERSONAL,
        currency_id: 1,
        invites: ['a@example.com'],
      };

      await expect(service.create(1, dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects more invites than the pending-invite cap', async () => {
      const dto: CreateSpaceDto = {
        name: 'Family',
        type: SpaceType.GROUP,
        currency_id: 1,
        invites: Array.from({ length: SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE + 1 }, (_, i) => `u${i}@example.com`),
      };

      await expect(service.create(1, dto)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('propagates a failure from inside the transaction', async () => {
      const dto: CreateSpaceDto = { name: 'Personal', type: SpaceType.PERSONAL, currency_id: 1 };
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
        buildSpaceMember({ space_id: 10, role: SpaceRole.OWNER }),
        buildSpaceMember({ space_id: 11, role: SpaceRole.MEMBER }),
      ]);
      spaceRepository.find.mockResolvedValue([
        buildSpace({
          id: 10,
          name: 'Personal',
          type: SpaceType.PERSONAL,
          currency: buildCurrency({ id: 1, code: 'USD', name: 'US dollar' }),
          created_at: new Date('2026-01-01'),
        }),
        buildSpace({
          id: 11,
          name: 'Family',
          type: SpaceType.GROUP,
          currency: buildCurrency({ id: 1, code: 'USD', name: 'US dollar' }),
          created_at: new Date('2026-01-02'),
        }),
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

  describe('getForMember', () => {
    it('rejects a non-member before loading the space', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));

      await expect(service.getForMember(1, 10)).rejects.toMatchObject(
        new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403),
      );
      expect(spaceRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns the space with its currency for a member', async () => {
      const space = buildSpace({ id: 10, currency: buildCurrency({ id: 1, code: 'USD', name: 'US Dollar' }) });
      spaceRepository.findOne.mockResolvedValue(space);

      await expect(service.getForMember(1, 10)).resolves.toBe(space);
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 1);
      expect(spaceRepository.findOne).toHaveBeenCalledWith({ where: { id: 10 }, relations: { currency: true } });
    });

    it('returns 404 when the space is gone after the membership check', async () => {
      spaceRepository.findOne.mockResolvedValue(null);

      await expect(service.getForMember(1, 10)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });
  });

  describe('remove', () => {
    const owner = buildSpaceMember({ id: 1, space_id: 10, user_id: 1, role: SpaceRole.OWNER });
    const locked = (actor = owner, actorSpaces = 2) => ({ actor, members: [actor], actorSpaces });

    it('rejects a plain member before taking any lock', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));

      await expect(service.remove(1, 10)).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 1, SpaceRole.OWNER);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('decides under the member and space locks, in one write transaction', async () => {
      spaceAccessService.lockMembers.mockResolvedValue(locked());

      await service.remove(1, 10);

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(dataSource.transaction).toHaveBeenCalledWith('READ COMMITTED', expect.any(Function));
      expect(spaceAccessService.lockMembers).toHaveBeenCalledWith(10, 1, expect.anything());
      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith({ space_id: 10 });
      expect(spaceRepositoryInTx.delete).toHaveBeenCalledWith(10);
    });

    it('rejects an owner who lost ownership before the locks', async () => {
      spaceAccessService.lockMembers.mockResolvedValue(locked({ ...owner, role: SpaceRole.MEMBER }));

      await expect(service.remove(1, 10)).rejects.toMatchObject(new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403));
      expect(spaceRepositoryInTx.delete).not.toHaveBeenCalled();
    });

    it('rejects deleting the owner’s only remaining space, counted under the locks', async () => {
      spaceAccessService.lockMembers.mockResolvedValue(locked(owner, 1));

      await expect(service.remove(1, 10)).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_LAST_REMAINING, 400),
      );
      expect(spaceMemberRepository.count).not.toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.delete).not.toHaveBeenCalled();
      expect(spaceRepositoryInTx.delete).not.toHaveBeenCalled();
    });
  });

  describe('removeOwned', () => {
    const owner = buildSpaceMember({ id: 1, space_id: 10, user_id: 1, role: SpaceRole.OWNER });
    it('deletes the members, then the space, in the caller’s transaction', async () => {
      await service.removeOwned(manager, { actor: owner, members: [owner], actorSpaces: 2 });

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(spaceAccessService.assertMembership).not.toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.delete).toHaveBeenCalledWith({ space_id: 10 });
      expect(spaceRepositoryInTx.delete).toHaveBeenCalledWith(10);

      const memberCallOrder = spaceMemberRepositoryInTx.delete.mock.invocationCallOrder[0];
      const spaceCallOrder = spaceRepositoryInTx.delete.mock.invocationCallOrder[0];
      expect(memberCallOrder).toBeLessThan(spaceCallOrder);
    });

    it('propagates a failure from the deletion', async () => {
      spaceRepositoryInTx.delete.mockRejectedValue(new Error('db unavailable'));

      await expect(service.removeOwned(manager, { actor: owner, members: [owner], actorSpaces: 2 })).rejects.toThrow(
        'db unavailable',
      );
    });
  });
});
