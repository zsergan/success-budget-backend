import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvironmentVariables } from '@config/env.validation';
import type { SpaceInvite } from '@entities/space-invite.entity';
import { constantTimeEquals } from '@shared/utils';

export type InviteTokenSubject = Pick<SpaceInvite, 'id' | 'space_id' | 'email' | 'token_nonce'>;

export interface ParsedInviteToken {
  inviteId: number;
  proof: string;
}

const TOKEN_PATTERN = /^([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/;
const MAX_INVITE_ID = 2147483647;

export function newInviteTokenNonce(): string {
  return randomBytes(16).toString('hex');
}

export function parseInviteToken(token: string): ParsedInviteToken | null {
  const match = TOKEN_PATTERN.exec(token);
  const inviteId = match ? Number(match[1]) : 0;

  if (!match || inviteId > MAX_INVITE_ID) {
    return null;
  }

  return { inviteId, proof: match[2] };
}

// A token is `<invite id>.<proof>`. It only identifies the invitation;
// whether it can still be used is decided by the invitation's own state.
@Injectable()
export class SpaceInviteLinks {
  private readonly secret: string;
  private readonly origin: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.secret = configService.getOrThrow('INVITE_TOKEN_SECRET', { infer: true });
    this.origin = new URL(configService.getOrThrow('PUBLIC_WEB_ORIGIN', { infer: true })).origin;
  }

  token(invite: InviteTokenSubject): string {
    return `${invite.id}.${this.proof(invite)}`;
  }

  link(invite: InviteTokenSubject): string {
    return `${this.origin}/invite#token=${this.token(invite)}`;
  }

  proves(invite: InviteTokenSubject, proof: string): boolean {
    return invite.token_nonce !== null && constantTimeEquals(this.proof(invite), proof);
  }

  private proof(invite: InviteTokenSubject): string {
    if (invite.token_nonce === null) {
      throw new Error(`Invitation ${invite.id} has no link yet`);
    }

    return createHmac('sha256', this.secret)
      .update(JSON.stringify(['space-invite/v1', invite.id, invite.space_id, invite.token_nonce, invite.email]))
      .digest('base64url');
  }
}
