import { createHmac } from 'node:crypto';
import { instanceToPlain } from 'class-transformer';

import { SpaceInviteLinks, newInviteTokenNonce, parseInviteToken } from './space-invite-links';
import { SpaceInviteEmailStatus } from '@shared/enums';
import { buildConfigService, buildSpaceInvite } from '@testing';

const SECRET = 'invite-token-secret-for-unit-tests-only';
const JWT_SECRET = 'jwt-secret-for-unit-tests-only';

const linksWith = (secret: string, origin = 'https://app.example.com') =>
  new SpaceInviteLinks(buildConfigService({ INVITE_TOKEN_SECRET: secret, PUBLIC_WEB_ORIGIN: origin }));

describe('SpaceInviteLinks', () => {
  const links = linksWith(SECRET);
  const invite = buildSpaceInvite({ id: 42, space_id: 10, email: 'anna@example.com', code: '042917' });

  it('issues `<invite id>.<43-character proof>`, which parses back', () => {
    const token = links.token(invite);

    expect(token).toMatch(/^42\.[A-Za-z0-9_-]{43}$/);
    expect(parseInviteToken(token)).toEqual({ inviteId: 42, proof: token.slice(3) });
  });

  it('builds the link from the configured origin, with the token in the fragment', () => {
    expect(links.link(invite)).toBe(`https://app.example.com/invite#token=${links.token(invite)}`);
    expect(linksWith(SECRET, 'http://localhost:3000').link(invite)).toMatch(/^http:\/\/localhost:3000\/invite#token=/);
  });

  it('is stable across calls, instances and delivery state', () => {
    const token = links.token(invite);
    const retried = buildSpaceInvite({
      ...invite,
      email_status: SpaceInviteEmailStatus.SENT,
      email_attempts: 3,
      email_attempt_id: 9,
      email_last_sent_at: new Date(),
    });

    expect(links.token(invite)).toBe(token);
    expect(linksWith(SECRET).token(invite)).toBe(token);
    expect(links.token(retried)).toBe(token);
  });

  it('proves its own invitation only', () => {
    const [, proof] = links.token(invite).split('.');

    expect(links.proves(invite, proof)).toBe(true);
    expect(links.proves(buildSpaceInvite({ ...invite, id: 43 }), proof)).toBe(false);
    expect(links.proves(buildSpaceInvite({ ...invite, space_id: 11 }), proof)).toBe(false);
    expect(links.proves(buildSpaceInvite({ ...invite, email: 'ben@example.com' }), proof)).toBe(false);
    expect(links.proves(buildSpaceInvite({ ...invite, token_nonce: newInviteTokenNonce() }), proof)).toBe(false);
  });

  it('rejects any changed character of the proof', () => {
    const [, proof] = links.token(invite).split('.');

    for (let index = 0; index < proof.length; index++) {
      const changed = proof.slice(0, index) + (proof[index] === 'A' ? 'B' : 'A') + proof.slice(index + 1);
      expect(links.proves(invite, changed)).toBe(false);
    }

    expect(links.proves(invite, proof.slice(1))).toBe(false);
    expect(links.proves(invite, '')).toBe(false);
  });

  it('cannot be derived from the invitation id or the code', () => {
    const [, proof] = links.token(invite).split('.');
    const sameIdAndCode = buildSpaceInvite({ ...invite, token_nonce: newInviteTokenNonce() });

    expect(proof).not.toContain(invite.code);
    expect(links.token(sameIdAndCode)).not.toBe(links.token(invite));
    expect(links.token(buildSpaceInvite({ ...invite, code: '999999' }))).toBe(links.token(invite));
  });

  it('depends on its own secret, never the JWT secret', () => {
    const [, proof] = links.token(invite).split('.');
    const jwtSigned = createHmac('sha256', JWT_SECRET)
      .update(JSON.stringify(['space-invite/v1', invite.id, invite.space_id, invite.token_nonce, invite.email]))
      .digest('base64url');

    expect(linksWith('another-invite-token-secret-value-xyz').proves(invite, proof)).toBe(false);
    expect(links.proves(invite, jwtSigned)).toBe(false);
    expect(linksWith(JWT_SECRET).proves(invite, proof)).toBe(false);
  });

  it('has no link for a legacy invitation without a nonce', () => {
    const legacy = buildSpaceInvite({ ...invite, token_nonce: null });

    expect(() => links.token(legacy)).toThrow('has no link yet');
    expect(links.proves(legacy, links.token(invite).split('.')[1])).toBe(false);
  });
});

describe('parseInviteToken', () => {
  const proof = 'a'.repeat(43);

  it.each([
    ['', 'empty'],
    [proof, 'no id'],
    [`0.${proof}`, 'id 0'],
    [`042.${proof}`, 'a leading zero'],
    [`2147483648.${proof}`, 'an id over INT'],
    [`-1.${proof}`, 'a negative id'],
    [`42.${proof}a`, 'a long proof'],
    [`42.${proof.slice(1)}`, 'a short proof'],
    [`42.${proof.slice(1)}=`, 'padding'],
    [`42.${proof.slice(1)}+`, 'non-base64url'],
    [` 42.${proof}`, 'whitespace'],
    [`42.${proof}\n`, 'a trailing newline'],
    [`42..${proof}`, 'two dots'],
  ])('rejects %j (%s)', (token) => {
    expect(parseInviteToken(token)).toBeNull();
  });

  it('accepts the largest invitation id', () => {
    expect(parseInviteToken(`2147483647.${proof}`)).toEqual({ inviteId: 2147483647, proof });
  });
});

describe('newInviteTokenNonce', () => {
  it('is 32 lowercase hex characters and different every time', () => {
    const nonces = new Set(Array.from({ length: 100 }, newInviteTokenNonce));

    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('SpaceInvite serialization', () => {
  it('exposes no code, nonce, acceptor or delivery state', () => {
    const invite = buildSpaceInvite({
      accepted_at: new Date(),
      accepted_by_user_id: 2,
      email_status: SpaceInviteEmailStatus.SENDING,
      email_next_attempt_at: new Date(),
      email_lease_expires_at: new Date(),
      email_last_sent_at: new Date(),
    });

    expect(Object.keys(instanceToPlain(invite)).sort()).toEqual(['created_at', 'email', 'id', 'role']);
  });
});
