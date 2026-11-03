import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, MoreThan, Repository } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceMember } from '@entities/space-member.entity';
import type { User } from '@entities/user.entity';
import { SpaceInviteEmailStatus, SpaceRole, SpaceType } from '@shared/enums';
import { SPACE_LIMITS } from '@shared/constants';
import { ApiException } from '@shared/api.exception';
import { assertFound, lockRows, runWriteTransaction, withRelations } from '@shared/utils';
import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { UsersService } from '@modules/users/users.service';
import { SpacesService, type SpaceWithCurrency } from './spaces.service';
import { SpaceInviteLinks, parseInviteToken } from './space-invite-links';
import { isActiveInvite, isInviteFor, newInvite, normalizeInviteEmail } from './space-invite-state';
import { SpaceInviteDelivery, effectiveStatus, type InviteDeliveryView } from './space-invite-delivery';

export { isActiveInvite } from './space-invite-state';

export interface SpaceInviteState {
  id: number;
  email: string;
  expires_at: Date;
  email_status: SpaceInviteEmailStatus;
  resend_after_seconds: number;
}

export interface CreatedSpaceInvite extends SpaceInviteState {
  code: string;
}

export interface SpaceInvitePreview {
  space: { name: string; currency: { id: number; code: string; name: string } };
  expires_at: Date;
}

// How the caller found the invitation: the link token, or the manual code,
// which keeps its original errors.
type InviteCredential = 'token' | 'code';

@Injectable()
export class SpaceInvitesService {
  constructor(
    @InjectRepository(SpaceInvite)
    private readonly spaceInviteRepository: Repository<SpaceInvite>,
    @InjectRepository(SpaceMember)
    private readonly spaceMemberRepository: Repository<SpaceMember>,
    private readonly dataSource: DataSource,
    private readonly spaceAccessService: SpaceAccessService,
    private readonly spacesService: SpacesService,
    private readonly usersService: UsersService,
    private readonly spaceInviteLinks: SpaceInviteLinks,
    private readonly delivery: SpaceInviteDelivery,
  ) {}

  // Locks: member (S), space (X), so the active-invitation check and the
  // limits see every committed invitation of the space. An active invitation
  // for the same address is returned as it is: no second row, no second
  // email. A new one is emailed after the commit.
  async create(userId: number, spaceId: number, email: string): Promise<CreatedSpaceInvite> {
    const address = normalizeInviteEmail(email);
    let scheduled: number | null = null;

    const created = await runWriteTransaction(this.dataSource, async (manager) => {
      scheduled = null;
      await this.lockOwner(spaceId, userId, manager);
      await this.spaceAccessService.lockSpace(spaceId, manager);
      const space = await this.spacesService.getOne(spaceId, manager);
      assertFound(space);

      if (space.type === SpaceType.PERSONAL) {
        throw new ApiException('SPACE_PERSONAL_NO_INVITES', HttpStatus.BAD_REQUEST);
      }

      const active = await this.getActive(space.id, manager);
      const existing = active.find((invite) => isInviteFor(invite, address));

      if (existing) {
        return existing;
      }

      if (active.length >= SPACE_LIMITS.MAX_PENDING_INVITES_PER_SPACE) {
        throw new ApiException('SPACE_INVITE_LIMIT_REACHED', HttpStatus.BAD_REQUEST);
      }

      const now = new Date();
      await this.delivery.assertCanSchedule(manager, { senderId: userId, spaceId, emails: [address] }, now);
      const repository = manager.getRepository(SpaceInvite);
      const saved = await repository.save(repository.create(newInvite(space.id, address, now)));
      await this.delivery.recordScheduled(manager, userId, [saved], now);
      scheduled = saved.id;

      return saved;
    });

    if (scheduled !== null) {
      this.delivery.deliverSoon([scheduled]);
    }

    // the only response that exposes the code; GET :id/members never does
    return { ...(await this.toState(created)), code: created.code };
  }

  // Locks: member (S), space (X), invitation (X). Same code, link and expiry:
  // only the email is scheduled again. See docs/invitations-contract.md#resend.
  async resend(userId: number, spaceId: number, inviteId: number): Promise<SpaceInviteState> {
    let deliver = false;

    const invite = await runWriteTransaction(this.dataSource, async (manager) => {
      deliver = false;
      await this.lockOwner(spaceId, userId, manager);
      await this.spaceAccessService.lockSpace(spaceId, manager);
      const locked = await this.lockInvite(manager, inviteId);
      const now = new Date();

      if (!locked || locked.space_id !== spaceId || !isActiveInvite(locked, now)) {
        throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
      }

      await this.delivery.assertCanSchedule(
        manager,
        { senderId: userId, spaceId, emails: [locked.email], inviteId: locked.id },
        now,
      );
      const status = effectiveStatus(locked, now);

      if (status === SpaceInviteEmailStatus.QUEUED) {
        await this.delivery.expedite(manager, locked, now);
        deliver = true;
      } else if (status !== SpaceInviteEmailStatus.SENDING) {
        await this.delivery.requeue(manager, userId, locked, now);
        deliver = true;
      }

      return locked;
    });

    if (deliver) {
      this.delivery.deliverSoon([invite.id]);
    }

    return this.toState(invite);
  }

  async getActive(spaceId: number, manager?: EntityManager): Promise<SpaceInvite[]> {
    const repository = manager?.getRepository(SpaceInvite) ?? this.spaceInviteRepository;

    return repository.find({
      where: { space_id: spaceId, accepted_at: IsNull(), revoked_at: IsNull(), expires_at: MoreThan(new Date()) },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  // the invitation the token was issued for, in any state: see isActiveInvite()
  async findByToken(token: string): Promise<SpaceInvite | null> {
    const parsed = parseInviteToken(token);

    if (!parsed) {
      return null;
    }

    const invite = await this.spaceInviteRepository.findOne({ where: { id: parsed.inviteId } });

    return invite && this.spaceInviteLinks.proves(invite, parsed.proof) ? invite : null;
  }

  // Locks: member (S), invitation (X). Also cancels its pending email: the
  // schedule is cleared and a running attempt can no longer record a result.
  async revoke(userId: number, spaceId: number, inviteId: number): Promise<void> {
    await runWriteTransaction(this.dataSource, async (manager) => {
      await this.lockOwner(spaceId, userId, manager);
      const invite = await this.lockInvite(manager, inviteId);

      if (!invite || invite.space_id !== spaceId || invite.accepted_at !== null || invite.revoked_at !== null) {
        throw new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
      }

      await manager.getRepository(SpaceInvite).update(invite.id, {
        revoked_at: new Date(),
        email_next_attempt_at: null,
        email_lease_expires_at: null,
        email_attempt_id: () => 'email_attempt_id + 1',
      });
    });
  }

  async preview(userId: number, token: string): Promise<SpaceInvitePreview> {
    const recipient = await this.getRecipient(userId);
    const invite = await this.findByToken(token);

    if (!invite) {
      throw unusable('token');
    }

    assertRecipient(invite, recipient, 'token');
    const member = await this.spaceMemberRepository.findOne({ where: { space_id: invite.space_id, user_id: userId } });

    if (member) {
      throw alreadyMember(invite.space_id);
    }

    if (!isActiveInvite(invite)) {
      throw unusable('token');
    }

    const space = await this.spacesService.getOne(invite.space_id);

    if (!space) {
      throw unusable('token');
    }

    const { id, code, name } = space.currency;

    return { space: { name: space.name, currency: { id, code, name } }, expires_at: invite.expires_at };
  }

  async acceptToken(userId: number, token: string): Promise<SpaceWithCurrency> {
    const recipient = await this.getRecipient(userId);
    const invite = await this.findByToken(token);

    if (!invite) {
      throw unusable('token');
    }

    return this.join(recipient, invite.id, 'token');
  }

  async accept(userId: number, code: string): Promise<SpaceWithCurrency> {
    const recipient = await this.getRecipient(userId);
    const candidates = (
      await this.spaceInviteRepository.find({ where: { email: recipient.email, code }, order: { id: 'DESC' } })
    ).filter((invite) => isInviteFor(invite, recipient.email));
    const invite =
      candidates.find((candidate) => isActiveInvite(candidate)) ??
      candidates.find((candidate) => candidate.accepted_by_user_id === recipient.id);

    if (!invite) {
      throw unusable('code');
    }

    return this.join(recipient, invite.id, 'code');
  }

  // Locks: space (X), invitation (X). The recipient has no member row to
  // lock yet; the space lock serializes accepts of the space, so the member
  // limit counts every committed member, and the invitation lock orders it
  // against revocation. Everything is checked again under the locks.
  private join(recipient: User, inviteId: number, credential: InviteCredential): Promise<SpaceWithCurrency> {
    return runWriteTransaction(this.dataSource, async (manager) => {
      const located = await manager.getRepository(SpaceInvite).findOne({ where: { id: inviteId } });

      if (!located) {
        throw unusable(credential);
      }

      await this.spaceAccessService.lockSpace(located.space_id, manager);
      const invite = await this.lockInvite(manager, inviteId);

      if (!invite) {
        throw unusable(credential);
      }

      assertRecipient(invite, recipient, credential);
      const members = manager.getRepository(SpaceMember);
      const member = await members.findOne({ where: { space_id: invite.space_id, user_id: recipient.id } });

      if (member) {
        if (invite.accepted_by_user_id === recipient.id) {
          return this.loadSpace(manager, invite.space_id);
        }

        throw alreadyMember(invite.space_id);
      }

      if (!isActiveInvite(invite)) {
        throw unusable(credential);
      }

      if ((await members.count({ where: { space_id: invite.space_id } })) >= SPACE_LIMITS.MAX_MEMBERS_PER_SPACE) {
        throw new ApiException('SPACE_MEMBER_LIMIT_REACHED', HttpStatus.BAD_REQUEST);
      }

      await members.insert({ space_id: invite.space_id, user_id: recipient.id, role: invite.role });
      await manager.getRepository(SpaceInvite).update(invite.id, {
        accepted_at: new Date(),
        accepted_by_user_id: recipient.id,
        email_next_attempt_at: null,
        email_lease_expires_at: null,
        email_attempt_id: () => 'email_attempt_id + 1',
      });

      return this.loadSpace(manager, invite.space_id);
    });
  }

  private async toState(invite: SpaceInvite): Promise<SpaceInviteState> {
    const view = (await this.delivery.describe([invite])).get(invite.id) as InviteDeliveryView;

    return { id: invite.id, email: invite.email, expires_at: invite.expires_at, ...view };
  }

  private async lockOwner(spaceId: number, userId: number, manager: EntityManager): Promise<void> {
    const member = await this.spaceAccessService.lockMembership(spaceId, userId, manager);

    if (member.role !== SpaceRole.OWNER) {
      throw new ApiException('FORBIDDEN_SPACE', HttpStatus.FORBIDDEN);
    }
  }

  private async lockInvite(manager: EntityManager, inviteId: number): Promise<SpaceInvite | undefined> {
    const [invite] = await lockRows(manager, SpaceInvite, [inviteId], 'exclusive');

    return invite;
  }

  private async getRecipient(userId: number): Promise<User> {
    const user = await this.usersService.findById(userId);
    assertFound(user);

    return user;
  }

  private async loadSpace(manager: EntityManager, spaceId: number): Promise<SpaceWithCurrency> {
    const space = await manager.getRepository(Space).findOne({ where: { id: spaceId }, relations: { currency: true } });
    assertFound(space);

    return withRelations(space, 'currency');
  }
}

function unusable(credential: InviteCredential): ApiException {
  return credential === 'token'
    ? new ApiException('SPACE_INVITE_UNUSABLE', HttpStatus.NOT_FOUND)
    : new ApiException('NOT_FOUND', HttpStatus.NOT_FOUND);
}

function alreadyMember(spaceId: number): ApiException {
  return new ApiException('SPACE_ALREADY_MEMBER', HttpStatus.CONFLICT, { spaceId });
}

// Another account learns only that a still active invitation is not theirs,
// never whose it is or the state of an ended one.
function assertRecipient(invite: SpaceInvite, recipient: User, credential: InviteCredential): void {
  if (isInviteFor(invite, recipient.email)) {
    return;
  }

  throw credential === 'token' && isActiveInvite(invite)
    ? new ApiException('SPACE_INVITE_EMAIL_MISMATCH', HttpStatus.FORBIDDEN)
    : unusable(credential);
}
