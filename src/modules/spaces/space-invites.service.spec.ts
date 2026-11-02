import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HttpException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SpaceInvitesService, isActiveInvite } from './space-invites.service';
import { SpacesService, type SpaceWithCurrency } from './spaces.service';
import { SpaceInviteLinks } from './space-invite-links';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import { SpaceInviteEmailStatus, SpaceRole, SpaceType } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { SPACE_LIMITS } from '@shared/constants';
import { withRelations } from '@shared/utils';
import { buildConfigService, buildCurrency, buildSpace, buildSpaceInvite, buildSpaceMember, buildUser } from '@testing';

type Where = Record<string, unknown>;

const SPACE_ID = 10;
const OWNER_ID = 7;
const RECIPIENT_ID = 2;
const RECIPIENT_EMAIL = 'Anna@Example.com';

const later = () => new Date(Date.now() + 60_000);
const earlier = () => new Date(Date.now() - 60_000);

const apiError = (code: keyof typeof ErrorMessages, status: number) => new HttpException(ErrorMessages[code], status);

describe('SpaceInvitesService', () => {
  let service: SpaceInvitesService;
  let invites: SpaceInvite[];
  let members: SpaceMember[];
  let space: SpaceWithCurrency;
  let calls: string[];
  let spaceAccessService: { lockMembership: jest.Mock; lockSpace: jest.Mock };
  let usersService: { findById: jest.Mock };

  const links = new SpaceInviteLinks(
    buildConfigService({
      INVITE_TOKEN_SECRET: 'invite-token-secret-for-unit-tests-only',
      PUBLIC_WEB_ORIGIN: 'https://app.example.com',
    }),
  );

  const invite = (overrides: Partial<SpaceInvite> = {}) => {
    const row = buildSpaceInvite({
      id: invites.length + 1,
      space_id: SPACE_ID,
      email: 'anna@example.com',
      expires_at: later(),
      ...overrides,
    });
    invites.push(row);

    return row;
  };

  const member = (userId: number, spaceId = SPACE_ID) => {
    const row = buildSpaceMember({ id: members.length + 100, space_id: spaceId, user_id: userId });
    members.push(row);

    return row;
  };

  // Repositories over the in-memory rows: just enough of TypeORM for these paths.
  const inviteRepository = {
    create: jest.fn((entity: Partial<SpaceInvite>) => Object.assign(new SpaceInvite(), entity)),
    save: jest.fn(async (entity: SpaceInvite) => {
      const saved = buildSpaceInvite({ ...entity, id: invites.length + 1, created_at: new Date() });
      invites.push(saved);
      calls.push('insert invite');

      return saved;
    }),
    findOne: jest.fn(async ({ where }: { where: Where }) => invites.find((row) => row.id === where.id) ?? null),
    // a code lookup compares emails case-insensitively, like the column collation
    find: jest.fn(async ({ where }: { where: Where }) =>
      'code' in where
        ? invites.filter(
            (row) =>
              row.code === where.code &&
              row.email.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() ===
                String(where.email).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(),
          )
        : invites.filter((row) => row.space_id === where.space_id && isActiveInvite(row)),
    ),
    update: jest.fn(async (id: number, patch: Record<string, unknown>) => {
      const row = invites.find((candidate) => candidate.id === id) as unknown as Record<string, unknown>;

      for (const [key, value] of Object.entries(patch)) {
        row[key] = typeof value === 'function' ? (row[key] as number) + 1 : value;
      }
    }),
  };
  const memberRepository = {
    findOne: jest.fn(
      async ({ where }: { where: Where }) =>
        members.find((row) => row.space_id === where.space_id && row.user_id === where.user_id) ?? null,
    ),
    count: jest.fn(
      async ({ where }: { where: Where }) => members.filter((row) => row.space_id === where.space_id).length,
    ),
    insert: jest.fn(async (row: Partial<SpaceMember>) => {
      members.push(buildSpaceMember(row));
      calls.push('insert member');
    }),
  };
  const lockQuery = () => {
    let ids: number[] = [];
    const builder = {
      setLock: () => builder,
      whereInIds: (lockIds: number[]) => {
        ids = lockIds;
        return builder;
      },
      orderBy: () => builder,
      getMany: async () => {
        calls.push(`lock invite ${ids.join(',')}`);
        return invites.filter((row) => ids.includes(row.id));
      },
    };

    return builder;
  };
  const manager = {
    getRepository: (entity: unknown) => {
      if (entity === SpaceInvite) return inviteRepository;
      if (entity === SpaceMember) return memberRepository;
      if (entity === Space) return { findOne: async () => space };
      throw new Error(`Unexpected entity: ${String(entity)}`);
    },
    createQueryBuilder: lockQuery,
  };

  beforeEach(async () => {
    invites = [];
    members = [];
    calls = [];
    space = withRelations(
      buildSpace({ id: SPACE_ID, name: 'Family', type: SpaceType.GROUP, currency: buildCurrency() }),
      'currency',
    );
    jest.clearAllMocks();
    spaceAccessService = {
      lockMembership: jest.fn(async (spaceId: number, userId: number) => {
        calls.push(`lock member ${userId}`);
        return buildSpaceMember({ space_id: spaceId, user_id: userId, role: SpaceRole.OWNER });
      }),
      lockSpace: jest.fn(async (spaceId: number) => {
        calls.push(`lock space ${spaceId}`);
      }),
    };
    usersService = { findById: jest.fn(async () => buildUser({ id: RECIPIENT_ID, email: RECIPIENT_EMAIL })) };
    const dataSource = {
      transaction: jest.fn((...args: unknown[]) => (args[args.length - 1] as (m: unknown) => unknown)(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceInvitesService,
        { provide: getRepositoryToken(SpaceInvite), useValue: inviteRepository },
        { provide: getRepositoryToken(SpaceMember), useValue: memberRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: SpaceAccessService, useValue: spaceAccessService },
        { provide: SpacesService, useValue: { getOne: jest.fn(async () => space) } },
        { provide: UsersService, useValue: usersService },
        { provide: SpaceInviteLinks, useValue: links },
      ],
    }).compile();

    service = module.get(SpaceInvitesService);
  });

  describe('create', () => {
    it('refuses a plain member before locking the space', async () => {
      spaceAccessService.lockMembership.mockResolvedValue(buildSpaceMember({ role: SpaceRole.MEMBER }));

      await expect(service.create(OWNER_ID, SPACE_ID, 'a@example.com')).rejects.toMatchObject(
        apiError('FORBIDDEN_SPACE', 403),
      );
      expect(spaceAccessService.lockSpace).not.toHaveBeenCalled();
      expect(invites).toEqual([]);
    });

    it('refuses a personal space', async () => {
      space.type = SpaceType.PERSONAL;

      await expect(service.create(OWNER_ID, SPACE_ID, 'a@example.com')).rejects.toMatchObject(
        apiError('SPACE_PERSONAL_NO_INVITES', 400),
      );
    });

    it('refuses once the active-invitation limit is reached', async () => {
      for (let i = 0; i < SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE; i++) {
        invite({ email: `u${i}@example.com` });
      }

      await expect(service.create(OWNER_ID, SPACE_ID, 'a@example.com')).rejects.toMatchObject(
        apiError('SPACE_INVITE_LIMIT_REACHED', 400),
      );
    });

    it('stores a normalized invitation with its email queued, under the member and space locks', async () => {
      const result = await service.create(OWNER_ID, SPACE_ID, '  Anna@Example.COM ');

      expect(calls).toEqual([`lock member ${OWNER_ID}`, `lock space ${SPACE_ID}`, 'insert invite']);
      expect(invites).toEqual([
        expect.objectContaining({
          space_id: SPACE_ID,
          email: 'anna@example.com',
          role: SpaceRole.MEMBER,
          token_nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
          email_status: SpaceInviteEmailStatus.QUEUED,
          email_next_attempt_at: expect.any(Date),
        }),
      ]);
      expect(invites[0].expires_at.getMilliseconds()).toBe(0);
      expect(result).toEqual({
        id: 1,
        email: 'anna@example.com',
        expires_at: invites[0].expires_at,
        code: invites[0].code,
      });
    });

    it('returns the active invitation of the same address instead of a second one', async () => {
      const existing = invite({ email: 'Anna@example.com', email_status: SpaceInviteEmailStatus.SENT });

      const result = await service.create(OWNER_ID, SPACE_ID, 'anna@EXAMPLE.com');

      expect(result).toEqual({
        id: existing.id,
        email: existing.email,
        expires_at: existing.expires_at,
        code: existing.code,
      });
      expect(invites).toHaveLength(1);
      expect(existing.email_status).toBe(SpaceInviteEmailStatus.SENT);
    });

    it('creates a new invitation when the earlier one for the address has ended', async () => {
      invite({ revoked_at: earlier() });
      invite({ expires_at: earlier() });

      await service.create(OWNER_ID, SPACE_ID, 'anna@example.com');

      expect(invites).toHaveLength(3);
    });
  });

  describe('revoke', () => {
    it('refuses a plain member before locking the invitation', async () => {
      invite();
      spaceAccessService.lockMembership.mockResolvedValue(buildSpaceMember({ role: SpaceRole.MEMBER }));

      await expect(service.revoke(OWNER_ID, SPACE_ID, 1)).rejects.toMatchObject(apiError('FORBIDDEN_SPACE', 403));
      expect(calls).not.toContain('lock invite 1');
      expect(invites[0].revoked_at).toBeNull();
    });

    it.each([
      ['unknown', () => 99],
      ['of another space', () => invite({ space_id: SPACE_ID + 1 }).id],
      ['accepted', () => invite({ accepted_at: earlier() }).id],
      ['already revoked', () => invite({ revoked_at: earlier() }).id],
    ])('answers 404 for an invitation that is %s', async (_case, inviteId) => {
      await expect(service.revoke(OWNER_ID, SPACE_ID, inviteId())).rejects.toMatchObject(apiError('NOT_FOUND', 404));
    });

    it('revokes and cancels the pending email, after locking the member and the invitation', async () => {
      const row = invite({
        email_status: SpaceInviteEmailStatus.SENDING,
        email_attempt_id: 4,
        email_next_attempt_at: later(),
        email_lease_expires_at: later(),
      });

      await service.revoke(OWNER_ID, SPACE_ID, row.id);

      expect(calls).toEqual([`lock member ${OWNER_ID}`, `lock invite ${row.id}`]);
      expect(row).toMatchObject({
        revoked_at: expect.any(Date),
        email_next_attempt_at: null,
        email_lease_expires_at: null,
        email_attempt_id: 5,
      });
    });
  });

  describe('findByToken', () => {
    it('returns the invitation the token was issued for', async () => {
      const row = invite();

      await expect(service.findByToken(links.token(row))).resolves.toBe(row);
    });

    it('does not read anything for a malformed token', async () => {
      await expect(service.findByToken('1.short')).resolves.toBeNull();
      await expect(service.findByToken('123456')).resolves.toBeNull();
      expect(inviteRepository.findOne).not.toHaveBeenCalled();
    });

    it('rejects a tampered proof, a proof moved to another id and a legacy invitation without a link', async () => {
      const row = invite();
      const other = invite({ email: 'ben@example.com' });
      const legacy = invite({ token_nonce: null });
      const [, proof] = links.token(row).split('.');
      const tampered = `${proof[0] === 'A' ? 'B' : 'A'}${proof.slice(1)}`;

      await expect(service.findByToken(`${row.id}.${tampered}`)).resolves.toBeNull();
      await expect(service.findByToken(`${other.id}.${proof}`)).resolves.toBeNull();
      await expect(service.findByToken(`${legacy.id}.${proof}`)).resolves.toBeNull();
      await expect(service.findByToken(`99.${proof}`)).resolves.toBeNull();
    });

    it('still identifies an ended invitation, which is not active', async () => {
      for (const ended of [{ expires_at: earlier() }, { revoked_at: earlier() }, { accepted_at: earlier() }]) {
        const row = invite(ended);

        await expect(service.findByToken(links.token(row))).resolves.toBe(row);
        expect(isActiveInvite(row)).toBe(false);
      }

      expect(isActiveInvite(buildSpaceInvite({ expires_at: later() }))).toBe(true);
    });
  });

  describe('preview', () => {
    it('shows the space name, currency and expiry only', async () => {
      const row = invite();
      const { id, code, name } = space.currency;

      await expect(service.preview(RECIPIENT_ID, links.token(row))).resolves.toEqual({
        space: { name: 'Family', currency: { id, code, name } },
        expires_at: row.expires_at,
      });
    });

    it('answers 404 for a missing account', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.preview(RECIPIENT_ID, links.token(invite()))).rejects.toMatchObject(
        apiError('NOT_FOUND', 404),
      );
    });

    it('answers SPACE_INVITE_UNUSABLE for an unknown token or an ended invitation', async () => {
      await expect(service.preview(RECIPIENT_ID, `1.${'a'.repeat(43)}`)).rejects.toMatchObject(
        apiError('SPACE_INVITE_UNUSABLE', 404),
      );

      for (const ended of [{ expires_at: earlier() }, { revoked_at: earlier() }]) {
        await expect(service.preview(RECIPIENT_ID, links.token(invite(ended)))).rejects.toMatchObject(
          apiError('SPACE_INVITE_UNUSABLE', 404),
        );
      }
    });

    it('tells another account only that a still active invitation is not theirs', async () => {
      const active = invite({ email: 'ben@example.com' });
      const revoked = invite({ email: 'ben@example.com', revoked_at: earlier() });

      await expect(service.preview(RECIPIENT_ID, links.token(active))).rejects.toMatchObject(
        apiError('SPACE_INVITE_EMAIL_MISMATCH', 403),
      );
      await expect(service.preview(RECIPIENT_ID, links.token(revoked))).rejects.toMatchObject(
        apiError('SPACE_INVITE_UNUSABLE', 404),
      );
    });

    it('does not match an address that differs in more than case', async () => {
      usersService.findById.mockResolvedValue(buildUser({ id: RECIPIENT_ID, email: 'review@example.com' }));

      await expect(
        service.preview(RECIPIENT_ID, links.token(invite({ email: 'réview@example.com' }))),
      ).rejects.toMatchObject(apiError('SPACE_INVITE_EMAIL_MISMATCH', 403));
    });

    it('answers SPACE_ALREADY_MEMBER with the space id to a member', async () => {
      member(RECIPIENT_ID);

      const error = await service.preview(RECIPIENT_ID, links.token(invite())).catch((caught: HttpException) => caught);

      expect(error).toMatchObject(apiError('SPACE_ALREADY_MEMBER', 409));
      expect((error as HttpException).getResponse()).toMatchObject({ spaceId: SPACE_ID });
    });
  });

  describe('acceptToken', () => {
    it('joins under the space and invitation locks and ends the invitation', async () => {
      const row = invite({ email_next_attempt_at: later(), email_status: SpaceInviteEmailStatus.QUEUED });

      await expect(service.acceptToken(RECIPIENT_ID, links.token(row))).resolves.toBe(space);

      expect(calls).toEqual([`lock space ${SPACE_ID}`, `lock invite ${row.id}`, 'insert member']);
      expect(members).toEqual([
        expect.objectContaining({ space_id: SPACE_ID, user_id: RECIPIENT_ID, role: SpaceRole.MEMBER }),
      ]);
      expect(row).toMatchObject({
        accepted_at: expect.any(Date),
        accepted_by_user_id: RECIPIENT_ID,
        email_next_attempt_at: null,
      });
    });

    it('answers a repeat by the account that joined with the space, writing nothing', async () => {
      const row = invite({ accepted_at: earlier(), accepted_by_user_id: RECIPIENT_ID });
      member(RECIPIENT_ID);

      await expect(service.acceptToken(RECIPIENT_ID, links.token(row))).resolves.toBe(space);
      expect(members).toHaveLength(1);
      expect(inviteRepository.update).not.toHaveBeenCalled();
    });

    it('never restores a membership the account left or lost', async () => {
      const row = invite({ accepted_at: earlier(), accepted_by_user_id: RECIPIENT_ID });

      await expect(service.acceptToken(RECIPIENT_ID, links.token(row))).rejects.toMatchObject(
        apiError('SPACE_INVITE_UNUSABLE', 404),
      );
      expect(members).toEqual([]);
    });

    it('answers SPACE_ALREADY_MEMBER to a member who did not accept this invitation', async () => {
      const row = invite();
      member(RECIPIENT_ID);

      await expect(service.acceptToken(RECIPIENT_ID, links.token(row))).rejects.toMatchObject(
        apiError('SPACE_ALREADY_MEMBER', 409),
      );
      expect(row.accepted_at).toBeNull();
    });

    it('refuses a full space, counting under the space lock', async () => {
      for (let i = 0; i < SPACE_LIMITS.MAX_MEMBERS_PER_SPACE; i++) {
        member(1000 + i);
      }

      await expect(service.acceptToken(RECIPIENT_ID, links.token(invite()))).rejects.toMatchObject(
        apiError('SPACE_MEMBER_LIMIT_REACHED', 400),
      );
      expect(invites[0].accepted_at).toBeNull();
    });

    it('rechecks the invitation under its lock', async () => {
      const row = invite();
      spaceAccessService.lockSpace.mockImplementation(async () => {
        row.revoked_at = new Date();
      });

      await expect(service.acceptToken(RECIPIENT_ID, links.token(row))).rejects.toMatchObject(
        apiError('SPACE_INVITE_UNUSABLE', 404),
      );
      expect(members).toEqual([]);
    });

    it('refuses another account and an unknown token', async () => {
      await expect(
        service.acceptToken(RECIPIENT_ID, links.token(invite({ email: 'ben@example.com' }))),
      ).rejects.toMatchObject(apiError('SPACE_INVITE_EMAIL_MISMATCH', 403));
      await expect(service.acceptToken(RECIPIENT_ID, `5.${'a'.repeat(43)}`)).rejects.toMatchObject(
        apiError('SPACE_INVITE_UNUSABLE', 404),
      );
      expect(members).toEqual([]);
    });
  });

  describe('accept (code)', () => {
    it('answers 404 when the caller no longer exists', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.accept(RECIPIENT_ID, '123456')).rejects.toMatchObject(apiError('NOT_FOUND', 404));
      expect(inviteRepository.find).not.toHaveBeenCalled();
    });

    it('keeps NOT_FOUND for a code without an active invitation for the caller', async () => {
      invite({ code: '111111' });
      invite({ code: '123456', email: 'ben@example.com' });
      invite({ code: '123456', revoked_at: earlier() });

      await expect(service.accept(RECIPIENT_ID, '123456')).rejects.toMatchObject(apiError('NOT_FOUND', 404));
      expect(members).toEqual([]);
    });

    it('joins with the active invitation the code belongs to', async () => {
      invite({ code: '123456', accepted_at: earlier(), accepted_by_user_id: 99 });
      const active = invite({ code: '123456', email: 'ANNA@example.com' });

      await expect(service.accept(RECIPIENT_ID, '123456')).resolves.toBe(space);
      expect(active.accepted_by_user_id).toBe(RECIPIENT_ID);
      expect(members).toHaveLength(1);
    });

    it('answers a repeat by the account that joined with the space', async () => {
      invite({ code: '123456', accepted_at: earlier(), accepted_by_user_id: RECIPIENT_ID });
      member(RECIPIENT_ID);

      await expect(service.accept(RECIPIENT_ID, '123456')).resolves.toBe(space);
      expect(members).toHaveLength(1);
    });

    it('answers SPACE_ALREADY_MEMBER to a member using a code of their own space', async () => {
      invite({ code: '123456' });
      member(RECIPIENT_ID);

      await expect(service.accept(RECIPIENT_ID, '123456')).rejects.toMatchObject(apiError('SPACE_ALREADY_MEMBER', 409));
    });

    it('refuses an address that differs in more than case, which the column collation would match', async () => {
      usersService.findById.mockResolvedValue(buildUser({ id: RECIPIENT_ID, email: 'review@example.com' }));
      invite({ code: '123456', email: 'réview@example.com' });

      await expect(service.accept(RECIPIENT_ID, '123456')).rejects.toMatchObject(apiError('NOT_FOUND', 404));
    });
  });
});
