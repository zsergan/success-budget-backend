import type { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceInviteEmailStatus, SpaceRole } from '@shared/enums';
import { SPACE_INVITE_TTL_MS } from '@shared/constants';
import { generateRandomNumberString } from '@shared/utils';
import { newInviteTokenNonce } from './space-invite-links';

// Invitations are stored, compared and matched to accounts in this form. The
// comparison is made here, not by the column's collation, which also equates
// accented and unaccented letters.
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isInviteFor(invite: Pick<SpaceInvite, 'email'>, email: string): boolean {
  return normalizeInviteEmail(invite.email) === normalizeInviteEmail(email);
}

export function isActiveInvite(
  invite: Pick<SpaceInvite, 'accepted_at' | 'revoked_at' | 'expires_at'>,
  now = new Date(),
): boolean {
  return invite.accepted_at === null && invite.revoked_at === null && invite.expires_at > now;
}

// A new invitation with its first email queued, to be inserted in the same
// transaction as whatever created it. expires_at is whole seconds, as the
// column stores it, so every response shows the stored value.
export function newInvite(spaceId: number, email: string, now = new Date()): Partial<SpaceInvite> {
  return {
    space_id: spaceId,
    email: normalizeInviteEmail(email),
    code: generateRandomNumberString(),
    role: SpaceRole.MEMBER,
    expires_at: new Date(Math.floor((now.getTime() + SPACE_INVITE_TTL_MS) / 1000) * 1000),
    token_nonce: newInviteTokenNonce(),
    email_status: SpaceInviteEmailStatus.QUEUED,
    email_next_attempt_at: now,
  };
}
