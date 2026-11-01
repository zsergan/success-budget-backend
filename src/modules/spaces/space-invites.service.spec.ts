import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { SpaceInvitesService, isActiveInvite } from './space-invites.service';
import { SpacesService } from './spaces.service';
import { SpaceInviteLinks } from './space-invite-links';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceRole, SpaceType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SPACE_LIMITS } from '@shared/constants';
import { withRelations } from '@shared/utils';
import { buildConfigService, buildCurrency, buildSpace, buildSpaceInvite, buildSpaceMember, buildUser } from '@testing';

describe('SpaceInvitesService', () => {
  let service: SpaceInvitesService;
  let spaceInviteRepository: jest.Mocked<Repository<SpaceInvite>>;
  let spaceMemberRepository: jest.Mocked<Repository<SpaceMember>>;
  let spaceInviteRepositoryInTx: { update: jest.Mock };
  let spaceMemberRepositoryInTx: { create: jest.Mock; save: jest.Mock };
  let spaceRepositoryInTx: { findOne: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let spaceAccessService: jest.Mocked<Pick<SpaceAccessService, 'assertMembership'>>;
  let spacesService: jest.Mocked<Pick<SpacesService, 'getOne'>>;
  let usersService: jest.Mocked<Pick<UsersService, 'findById'>>;

  const spaceOfType = (type: SpaceType) =>
    withRelations(buildSpace({ id: 1, type, currency: buildCurrency() }), 'currency');

  const links = new SpaceInviteLinks(
    buildConfigService({
      INVITE_TOKEN_SECRET: 'invite-token-secret-for-unit-tests-only',
      PUBLIC_WEB_ORIGIN: 'https://app.example.com',
    }),
  );

  const forbidden = () => new HttpException(ErrorMessages.FORBIDDEN_SPACE, 403);

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
    spaceAccessService = { assertMembership: jest.fn().mockResolvedValue(buildSpaceMember({ role: SpaceRole.OWNER })) };
    spacesService = { getOne: jest.fn().mockResolvedValue(spaceOfType(SpaceType.GROUP)) };
    usersService = { findById: jest.fn().mockResolvedValue(buildUser({ id: 2, email: 'a@example.com' })) };

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
        { provide: SpaceAccessService, useValue: spaceAccessService },
        { provide: SpacesService, useValue: spacesService },
        { provide: UsersService, useValue: usersService },
        { provide: SpaceInviteLinks, useValue: links },
      ],
    }).compile();

    service = module.get(SpaceInvitesService);
    spaceInviteRepository = module.get(getRepositoryToken(SpaceInvite));
    spaceMemberRepository = module.get(getRepositoryToken(SpaceMember));
  });

  describe('create', () => {
    it('rejects a plain member before loading the space', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.create(7, 1, 'a@example.com')).rejects.toMatchObject(forbidden());
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(1, 7, SpaceRole.OWNER);
      expect(spacesService.getOne).not.toHaveBeenCalled();
      expect(spaceInviteRepository.save).not.toHaveBeenCalled();
    });

    it('returns 404 when the space is gone after the membership check', async () => {
      spacesService.getOne.mockResolvedValue(null);

      await expect(service.create(7, 1, 'a@example.com')).rejects.toMatchObject(
        new HttpException(ErrorMessages.NOT_FOUND, 404),
      );
      expect(spaceInviteRepository.save).not.toHaveBeenCalled();
    });

    it('rejects inviting into a personal space', async () => {
      spacesService.getOne.mockResolvedValue(spaceOfType(SpaceType.PERSONAL));

      await expect(service.create(7, 1, 'a@example.com')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_PERSONAL_NO_INVITES, 400),
      );
      expect(spaceInviteRepository.save).not.toHaveBeenCalled();
    });

    it('rejects once the active-invite cap is reached', async () => {
      spaceInviteRepository.find.mockResolvedValue(
        Array.from({ length: SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE }, () => buildSpaceInvite()),
      );

      await expect(service.create(7, 1, 'a@example.com')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_INVITE_LIMIT_REACHED, 400),
      );
    });

    it('creates the invite and returns the only view that exposes its code', async () => {
      spaceInviteRepository.find.mockResolvedValue([]);
      spaceInviteRepository.save.mockImplementation(async (entity) =>
        Object.assign(buildSpaceInvite(), entity, { id: 5 }),
      );

      const result = await service.create(7, 1, 'a@example.com');

      expect(spaceAccessService.assertMembership).toHaveBeenCalledTimes(1);
      expect(spacesService.getOne).toHaveBeenCalledWith(1);
      expect(spaceInviteRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          space_id: 1,
          email: 'a@example.com',
          role: SpaceRole.MEMBER,
          token_nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        }),
      );
      expect(result).toEqual({
        id: 5,
        email: 'a@example.com',
        expires_at: expect.any(Date),
        code: expect.any(String),
      });
    });
  });

  describe('revoke', () => {
    it('rejects a plain member before looking up the invite', async () => {
      spaceAccessService.assertMembership.mockRejectedValue(forbidden());

      await expect(service.revoke(7, 10, 1)).rejects.toMatchObject(forbidden());
      expect(spaceAccessService.assertMembership).toHaveBeenCalledWith(10, 7, SpaceRole.OWNER);
      expect(spaceInviteRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown or already-resolved invite', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(null);

      await expect(service.revoke(7, 10, 1)).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });

    it('stamps revoked_at on the happy path', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(buildSpaceInvite({ id: 1 }));

      await service.revoke(7, 10, 1);

      expect(spaceInviteRepository.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 1, space_id: 10 }),
      });
      expect(spaceInviteRepository.update).toHaveBeenCalledWith(1, { revoked_at: expect.any(Date) });
    });
  });

  describe('accept', () => {
    it('returns 404 when the caller no longer exists', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.accept(2, '123456')).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
      expect(spaceInviteRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects when no active invite matches the code and caller email', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(null);

      await expect(service.accept(2, '123456')).rejects.toMatchObject(new HttpException(ErrorMessages.NOT_FOUND, 404));
    });

    it('rejects when the space has reached its member cap', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(
        buildSpaceInvite({ id: 1, space_id: 10, role: SpaceRole.MEMBER }),
      );
      spaceMemberRepository.count.mockResolvedValue(SPACE_LIMITS.MAX_MEMBERS_PER_SPACE);

      await expect(service.accept(2, '123456')).rejects.toMatchObject(
        new HttpException(ErrorMessages.SPACE_MEMBER_LIMIT_REACHED, 400),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('creates the membership and stamps accepted_at and the acceptor in one transaction', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(
        buildSpaceInvite({ id: 1, space_id: 10, role: SpaceRole.MEMBER }),
      );
      spaceMemberRepository.count.mockResolvedValue(1);
      const space = buildSpace({ id: 10, currency: buildCurrency({ id: 1, code: 'USD', name: 'US Dollar' }) });
      spaceRepositoryInTx.findOne.mockResolvedValue(space);

      const result = await service.accept(2, '123456');

      expect(usersService.findById).toHaveBeenCalledWith(2);
      expect(spaceInviteRepository.findOne).toHaveBeenCalledWith({
        where: expect.objectContaining({ email: 'a@example.com', code: '123456' }),
      });
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(spaceMemberRepositoryInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: 10, user_id: 2, role: SpaceRole.MEMBER }),
      );
      expect(spaceInviteRepositoryInTx.update).toHaveBeenCalledWith(1, {
        accepted_at: expect.any(Date),
        accepted_by_user_id: 2,
      });
      expect(result).toBe(space);
    });
  });

  describe('findByToken', () => {
    const invite = buildSpaceInvite({ id: 42, space_id: 10, email: 'a@example.com' });

    it('returns the invitation the token was issued for', async () => {
      spaceInviteRepository.findOne.mockResolvedValue(invite);

      await expect(service.findByToken(links.token(invite))).resolves.toBe(invite);
      expect(spaceInviteRepository.findOne).toHaveBeenCalledWith({ where: { id: 42 } });
    });

    it('does not read anything for a malformed token', async () => {
      await expect(service.findByToken('42.short')).resolves.toBeNull();
      await expect(service.findByToken('123456')).resolves.toBeNull();
      expect(spaceInviteRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a tampered proof and a proof moved to another invitation id', async () => {
      const [, proof] = links.token(invite).split('.');
      const tampered = `${proof[0] === 'A' ? 'B' : 'A'}${proof.slice(1)}`;
      spaceInviteRepository.findOne.mockImplementation(async ({ where }) =>
        buildSpaceInvite({ ...invite, id: (where as { id: number }).id }),
      );

      await expect(service.findByToken(`42.${tampered}`)).resolves.toBeNull();
      await expect(service.findByToken(`43.${proof}`)).resolves.toBeNull();
    });

    it('rejects a token of an unknown invitation and of a legacy one without a link', async () => {
      spaceInviteRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findByToken(links.token(invite))).resolves.toBeNull();

      spaceInviteRepository.findOne.mockResolvedValueOnce(buildSpaceInvite({ ...invite, token_nonce: null }));
      await expect(service.findByToken(links.token(invite))).resolves.toBeNull();
    });

    it('still identifies an expired, revoked or accepted invitation, which is not active', async () => {
      const past = new Date(Date.now() - 1000);

      for (const ended of [{ expires_at: past }, { revoked_at: past }, { accepted_at: past, accepted_by_user_id: 2 }]) {
        const endedInvite = buildSpaceInvite({ ...invite, expires_at: new Date(Date.now() + 60_000), ...ended });
        spaceInviteRepository.findOne.mockResolvedValueOnce(endedInvite);

        await expect(service.findByToken(links.token(invite))).resolves.toBe(endedInvite);
        expect(isActiveInvite(endedInvite)).toBe(false);
      }

      expect(isActiveInvite(buildSpaceInvite({ expires_at: new Date(Date.now() + 60_000) }))).toBe(true);
    });
  });
});
