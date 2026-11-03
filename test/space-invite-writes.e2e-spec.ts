import request from 'supertest';

import { SpaceAccessService } from '@modules/space-access/space-access.service';
import { SpacesService } from '@modules/spaces/spaces.service';
import { SpaceInvitesService } from '@modules/spaces/space-invites.service';
import { SpaceInviteLinks } from '@modules/spaces/space-invite-links';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SPACE_LIMITS } from '@shared/constants';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { LOCK_MEMBERS, LOCK_SPACE, overlap, pauseAfterFirstCall } from './support/concurrency';

const LOCK_INVITE = '%FROM `space_invites` `row`%FOR UPDATE%';
const CLAIM_KEY = 'INSERT INTO `idempotency_keys`%';

describe('Space invitation writes (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(() => {
    testApp.resetThrottling();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  interface Person extends Member {
    email: string;
  }

  async function person(prefix: string): Promise<Person> {
    const created = await createVerifiedMember(testApp, prefix);
    userIds.push(created.userId);
    const [{ email }] = await testApp.dataSource.query('SELECT email FROM users WHERE id = ?', [created.userId]);

    return { ...created, email };
  }

  function api(member: Member) {
    const agent = request(testApp.app.getHttpServer());
    const withAuth =
      (method: 'get' | 'post' | 'delete') =>
      (url: string): request.Test =>
        agent[method](url).set('Authorization', `Bearer ${member.token}`);

    return { get: withAuth('get'), post: withAuth('post'), delete: withAuth('delete') };
  }

  async function groupSpace(owner: Member, invites?: string[]): Promise<number> {
    const response = await api(owner)
      .post('/api/v1/spaces')
      .send({ name: 'Family', currency_id: testApp.currencyId, type: 'group', invites })
      .expect(201);

    return response.body.id;
  }

  async function inviteTo(owner: Member, spaceId: number, email: string): Promise<SpaceInvite> {
    const response = await api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email }).expect(201);

    return testApp.dataSource.getRepository(SpaceInvite).findOneByOrFail({ id: response.body.id });
  }

  const tokenOf = (invite: SpaceInvite) => testApp.app.get(SpaceInviteLinks).token(invite);
  const accept = (member: Member, body: object) => api(member).post('/api/v1/spaces/invites/accept').send(body);
  const preview = (member: Member, token: string) => api(member).post('/api/v1/spaces/invites/preview').send({ token });

  async function memberships(spaceId: number, userId?: number): Promise<number> {
    const [{ count }] = await testApp.dataSource.query(
      `SELECT COUNT(*) AS count FROM space_members WHERE space_id = ?${userId ? ' AND user_id = ?' : ''}`,
      userId ? [spaceId, userId] : [spaceId],
    );

    return Number(count);
  }

  const invitationsOf = (spaceId: number) =>
    testApp.dataSource.getRepository(SpaceInvite).findBy({ space_id: spaceId });

  async function scheduledEmails(inviteId: number): Promise<number> {
    const [{ count }] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS count FROM space_invite_emails WHERE invite_id = ?',
      [inviteId],
    );

    return Number(count);
  }

  const pauseLockSpace = (spaceId: number) =>
    pauseAfterFirstCall(testApp.app.get(SpaceAccessService), 'lockSpace', (_self, [id]) => id === spaceId);
  const pauseLockInvite = () =>
    pauseAfterFirstCall(testApp.app.get(SpaceInvitesService) as unknown as { lockInvite: unknown }, 'lockInvite');

  describe('creating invitations', () => {
    it('gives two concurrent invitations of one address one row', async () => {
      const owner = await person('inv-dup-owner');
      const spaceId = await groupSpace(owner);
      const twice = `twice-${process.pid}-${Date.now()}@example.com`;
      const checkpoint = pauseLockSpace(spaceId);

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_SPACE,
        () => api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email: twice.toUpperCase() }),
        () => api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email: twice }),
      );

      expect([first.status, second.status]).toEqual([201, 201]);
      // the second answer shows the invitation's current email state, which the first one's send moves on
      expect(second.body).toEqual({
        ...first.body,
        email_status: expect.stringMatching(/^(queued|sending|sent)$/),
        resend_after_seconds: expect.any(Number),
      });
      expect(first.body.email).toBe(twice);
      expect(await invitationsOf(spaceId)).toEqual([expect.objectContaining({ email: twice })]);
      expect(await scheduledEmails(first.body.id)).toBe(1);
    });

    it('keeps an owner who is being removed from inviting once the removal committed', async () => {
      const owner = await person('inv-leave-owner');
      const other = await person('inv-leave-member');
      const spaceId = await groupSpace(owner, [other.email]);
      const [ownInvite] = await invitationsOf(spaceId);
      await accept(other, { token: tokenOf(ownInvite) }).expect(201);
      const checkpoint = pauseAfterFirstCall(
        testApp.app.get(SpaceAccessService),
        'lockMembership',
        (_self, [id, userId]) => id === spaceId && userId === owner.userId,
      );

      const [created, left] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_MEMBERS,
        () => api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email: 'during-leave@example.com' }),
        () => api(owner).delete(`/api/v1/spaces/${spaceId}/members/${owner.userId}`),
      );

      expect([created.status, left.status]).toEqual([201, 200]);
      expect(await memberships(spaceId, owner.userId)).toBe(0);

      const later = await api(owner)
        .post(`/api/v1/spaces/${spaceId}/invites`)
        .send({ email: 'after-leave@example.com' })
        .expect(403);
      expect(later.body.code).toBe('FORBIDDEN_SPACE');
      await api(owner).delete(`/api/v1/spaces/${spaceId}/invites/${created.body.id}`).expect(403);
      await api(other).post(`/api/v1/spaces/${spaceId}/invites`).send({ email: 'after-leave@example.com' }).expect(201);
    });
  });

  describe('creating a space with an Idempotency-Key', () => {
    const address = (label: string) => `e2e-${label}-${process.pid}-${Date.now()}@example.com`;
    const body = (name: string, invites = [address('a')]) => ({
      name,
      currency_id: testApp.currencyId,
      type: 'group',
      invites,
    });

    async function spacesNamed(userId: number, name: string): Promise<number[]> {
      const rows: { id: number }[] = await testApp.dataSource.query(
        `SELECT s.id FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? AND s.name = ?`,
        [userId, name],
      );

      return rows.map((row) => row.id);
    }

    it('replays the original space without a second space, invitation or email', async () => {
      const owner = await person('key-replay');
      const name = `Replay ${Date.now()}`;
      const payload = body(name);
      const first = await api(owner).post('/api/v1/spaces').set('Idempotency-Key', 'create-1').send(payload);
      const repeat = await api(owner).post('/api/v1/spaces').set('Idempotency-Key', 'create-1').send(payload);

      expect([first.status, repeat.status]).toEqual([201, 201]);
      expect(repeat.body).toEqual(first.body);
      expect(Object.keys(first.body).sort()).toEqual(['created_at', 'currency', 'id', 'name', 'type', 'updated_at']);
      expect(await spacesNamed(owner.userId, name)).toEqual([first.body.id]);
      const [invite] = await invitationsOf(first.body.id);
      expect(invite.email).toMatch(/^e2e-a-/);
      expect(await scheduledEmails(invite.id)).toBe(1);

      const changed = await api(owner)
        .post('/api/v1/spaces')
        .set('Idempotency-Key', 'create-1')
        .send(body(name, [address('b')]))
        .expect(409);
      expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await spacesNamed(owner.userId, name)).toEqual([first.body.id]);
    });

    it('lets a concurrent repeat wait for the first and return its space', async () => {
      const owner = await person('key-race');
      const name = `Race ${Date.now()}`;
      const checkpoint = pauseAfterFirstCall(
        testApp.app.get(SpacesService),
        'getOne',
        (_self, args) => args[1] !== undefined,
      );
      const payload = body(name);
      const send = () => api(owner).post('/api/v1/spaces').set('Idempotency-Key', 'create-race').send(payload);

      const [first, second] = await overlap(testApp.dataSource, checkpoint, CLAIM_KEY, send, send);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body).toEqual(first.body);
      expect(await spacesNamed(owner.userId, name)).toEqual([first.body.id]);
      expect(await invitationsOf(first.body.id)).toHaveLength(1);
    });

    it('scopes the key to the user', async () => {
      const [one, two] = [await person('key-scope-1'), await person('key-scope-2')];
      const name = `Scope ${Date.now()}`;

      const a = await api(one).post('/api/v1/spaces').set('Idempotency-Key', 'shared').send(body(name)).expect(201);
      const b = await api(two).post('/api/v1/spaces').set('Idempotency-Key', 'shared').send(body(name)).expect(201);

      expect(b.body.id).not.toBe(a.body.id);
    });
  });

  describe('preview', () => {
    it('shows only the space name, currency and expiry', async () => {
      const owner = await person('preview-owner');
      const recipient = await person('preview-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email.toUpperCase());

      const response = await preview(recipient, tokenOf(invite)).expect(200);

      expect(response.body).toEqual({
        space: {
          name: 'Family',
          currency: { id: testApp.currencyId, code: expect.any(String), name: expect.any(String) },
        },
        expires_at: invite.expires_at.toISOString(),
      });
      expect(await memberships(spaceId, recipient.userId)).toBe(0);
    });

    it('answers another account, an ended invitation and a member without revealing more', async () => {
      const owner = await person('preview-errors-owner');
      const recipient = await person('preview-errors-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);

      const mismatch = await preview(owner, tokenOf(invite)).expect(403);
      expect(mismatch.body.code).toBe('SPACE_INVITE_EMAIL_MISMATCH');
      expect(JSON.stringify(mismatch.body)).not.toContain(recipient.email);

      const [, proof] = tokenOf(invite).split('.');
      const tampered = await preview(recipient, `${invite.id}.${proof[0] === 'A' ? 'B' : 'A'}${proof.slice(1)}`);
      expect([tampered.status, tampered.body.code]).toEqual([404, 'SPACE_INVITE_UNUSABLE']);

      await accept(recipient, { token: tokenOf(invite) }).expect(201);
      const member = await preview(recipient, tokenOf(invite)).expect(409);
      expect(member.body).toMatchObject({ code: 'SPACE_ALREADY_MEMBER', spaceId });

      const ended = await preview(owner, tokenOf(invite)).expect(404);
      expect(ended.body.code).toBe('SPACE_INVITE_UNUSABLE');
    });
  });

  describe('accepting', () => {
    it('joins once when the same confirmation arrives twice at the same time', async () => {
      const owner = await person('accept-twice-owner');
      const recipient = await person('accept-twice-recipient');
      const spaceId = await groupSpace(owner);
      const token = tokenOf(await inviteTo(owner, spaceId, recipient.email));
      const checkpoint = pauseLockSpace(spaceId);

      const [first, second] = await overlap(
        testApp.dataSource,
        checkpoint,
        LOCK_SPACE,
        () => accept(recipient, { token }),
        () => accept(recipient, { token }),
      );

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body).toEqual(first.body);
      expect(first.body.id).toBe(spaceId);
      expect(Object.keys(first.body).sort()).toEqual([
        'created_at',
        'currency',
        'currency_id',
        'id',
        'name',
        'type',
        'updated_at',
      ]);
      expect(await memberships(spaceId, recipient.userId)).toBe(1);
    });

    it('joins once when the code and the link are used at the same time', async () => {
      const owner = await person('accept-both-owner');
      const recipient = await person('accept-both-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);

      const results = await Promise.all([
        accept(recipient, { token: tokenOf(invite) }),
        accept(recipient, { code: invite.code }),
      ]);

      expect(results.map((result) => result.status)).toEqual([201, 201]);
      expect(await memberships(spaceId, recipient.userId)).toBe(1);
    });

    it('lets the accepting account repeat, but never rejoin after leaving', async () => {
      const owner = await person('accept-repeat-owner');
      const recipient = await person('accept-repeat-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);

      const joined = await accept(recipient, { token: tokenOf(invite) }).expect(201);
      await expect(accept(recipient, { token: tokenOf(invite) }).expect(201)).resolves.toMatchObject({
        body: joined.body,
      });
      await accept(recipient, { code: invite.code }).expect(201);

      await api(recipient).delete(`/api/v1/spaces/${spaceId}/members/${recipient.userId}`).expect(200);

      const byToken = await accept(recipient, { token: tokenOf(invite) }).expect(404);
      expect(byToken.body.code).toBe('SPACE_INVITE_UNUSABLE');
      const byCode = await accept(recipient, { code: invite.code }).expect(404);
      expect(byCode.body.code).toBe('NOT_FOUND');
      expect(await memberships(spaceId, recipient.userId)).toBe(0);
    });

    it('refuses both credentials, neither, and another account', async () => {
      const owner = await person('accept-shape-owner');
      const recipient = await person('accept-shape-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);

      const both = await accept(recipient, { token: tokenOf(invite), code: invite.code }).expect(400);
      expect(both.body.message).toEqual([{ field: 'token', error: expect.any(String) }]);
      const neither = await accept(recipient, {}).expect(400);
      expect(neither.body.message).toEqual([expect.objectContaining({ field: 'code' })]);

      const other = await accept(owner, { token: tokenOf(invite) }).expect(403);
      expect(other.body.code).toBe('SPACE_INVITE_EMAIL_MISMATCH');
      expect(await memberships(spaceId, recipient.userId)).toBe(0);
    });

    it.each([
      ['accept holds the invitation first', 'accept'],
      ['revoke holds the invitation first', 'revoke'],
    ])('never both accepts and revokes an invitation (%s)', async (_case, first) => {
      const owner = await person('accept-revoke-owner');
      const recipient = await person('accept-revoke-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);
      const acceptIt = () => accept(recipient, { token: tokenOf(invite) });
      const revokeIt = () => api(owner).delete(`/api/v1/spaces/${spaceId}/invites/${invite.id}`);

      const [accepted, revoked] =
        first === 'accept'
          ? await overlap(testApp.dataSource, pauseLockInvite(), LOCK_INVITE, acceptIt, revokeIt)
          : (await overlap(testApp.dataSource, pauseLockInvite(), LOCK_INVITE, revokeIt, acceptIt)).reverse();
      const stored = await testApp.dataSource.getRepository(SpaceInvite).findOneByOrFail({ id: invite.id });

      if (first === 'accept') {
        expect([accepted.status, revoked.status]).toEqual([201, 404]);
        expect(stored).toMatchObject({ revoked_at: null, accepted_by_user_id: recipient.userId });
        expect(await memberships(spaceId, recipient.userId)).toBe(1);
      } else {
        expect([accepted.status, accepted.body.code, revoked.status]).toEqual([404, 'SPACE_INVITE_UNUSABLE', 200]);
        expect(stored).toMatchObject({ accepted_at: null, email_next_attempt_at: null });
        expect(stored.revoked_at).toBeInstanceOf(Date);
        expect(await memberships(spaceId, recipient.userId)).toBe(0);
      }
    });

    it('lets only one of two accepts take the last place in the space', async () => {
      const owner = await person('accept-cap-owner');
      const [one, two] = [await person('accept-cap-1'), await person('accept-cap-2')];
      const spaceId = await groupSpace(owner);
      const tokens = [
        tokenOf(await inviteTo(owner, spaceId, one.email)),
        tokenOf(await inviteTo(owner, spaceId, two.email)),
      ];
      const fillers = SPACE_LIMITS.MAX_MEMBERS_PER_SPACE - 2;
      const stamp = `${process.pid}-${Date.now()}`;

      for (let i = 0; i < fillers; i++) {
        const user: { insertId: number } = await testApp.dataSource.query(
          `INSERT INTO users (email, name, password, email_verified) VALUES (?, 'Filler', 'x', 1)`,
          [`e2e-filler-${stamp}-${i}@example.com`],
        );
        userIds.push(user.insertId);
        await testApp.dataSource.query(`INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, 'member')`, [
          spaceId,
          user.insertId,
        ]);
      }

      const [first, second] = await overlap(
        testApp.dataSource,
        pauseLockSpace(spaceId),
        LOCK_SPACE,
        () => accept(one, { token: tokens[0] }),
        () => accept(two, { token: tokens[1] }),
      );

      expect([first.status, second.status]).toEqual([201, 400]);
      expect(second.body.code).toBe('SPACE_MEMBER_LIMIT_REACHED');
      expect(await memberships(spaceId)).toBe(SPACE_LIMITS.MAX_MEMBERS_PER_SPACE);
    });
  });

  describe('leaving and deleting a space', () => {
    const leave = (member: Member, spaceId: number, userId = member.userId) =>
      api(member).delete(`/api/v1/spaces/${spaceId}/members/${userId}`);

    const roles = (spaceId: number): Promise<{ user_id: number; role: string }[]> =>
      testApp.dataSource.query('SELECT user_id, role FROM space_members WHERE space_id = ? ORDER BY id', [spaceId]);

    async function spaceExists(spaceId: number): Promise<boolean> {
      const rows: unknown[] = await testApp.dataSource.query('SELECT id FROM spaces WHERE id = ?', [spaceId]);

      return rows.length === 1;
    }

    async function joined(owner: Member, spaceId: number, prefix: string): Promise<Person> {
      const member = await person(prefix);
      await accept(member, { token: tokenOf(await inviteTo(owner, spaceId, member.email)) }).expect(201);

      return member;
    }

    async function spaceData(owner: Member, spaceId: number) {
      const wallet = await api(owner)
        .post(`/api/v1/spaces/${spaceId}/wallets`)
        .send({ wallet_name: 'Card', initial_balance: '100', design: 'slate' })
        .expect(201);
      const categories = await api(owner).get(`/api/v1/spaces/${spaceId}/categories`).expect(200);
      const transaction = await api(owner)
        .post(`/api/v1/spaces/${spaceId}/transactions`)
        .send({
          wallet_id: wallet.body.wallet.id,
          category_id: categories.body.expenses[0].id,
          transaction_type: 'expense',
          amount: '12.30',
          timestamp: '2026-09-15T10:00:00.000Z',
        })
        .expect(201);

      return {
        walletId: wallet.body.wallet.id as number,
        categoryId: categories.body.expenses[0].id as number,
        transactionId: transaction.body.transaction.id as number,
      };
    }

    it('transfers ownership to a member whose acceptance commits first, and keeps the space and its data', async () => {
      const owner = await person('leave-accept-owner');
      const recipient = await person('leave-accept-recipient');
      const spaceId = await groupSpace(owner);
      const token = tokenOf(await inviteTo(owner, spaceId, recipient.email));
      const data = await spaceData(owner, spaceId);
      const lockMembers = jest.spyOn(testApp.app.get(SpaceAccessService), 'lockMembers');

      const [accepted, left] = await overlap(
        testApp.dataSource,
        pauseLockSpace(spaceId),
        LOCK_SPACE,
        () => accept(recipient, { token }),
        () => leave(owner, spaceId),
      );

      expect([accepted.status, left.status]).toEqual([201, 200]);
      expect(lockMembers).toHaveBeenCalledTimes(2);
      expect(await roles(spaceId)).toEqual([{ user_id: recipient.userId, role: 'owner' }]);

      const [stored] = await testApp.dataSource.query(
        `SELECT w.id AS wallet_id, t.id AS transaction_id, t.category_id
         FROM wallets w JOIN transactions t ON t.wallet_id = w.id
         WHERE w.space_id = ? AND t.id = ?`,
        [spaceId, data.transactionId],
      );
      expect(stored).toEqual({
        wallet_id: data.walletId,
        transaction_id: data.transactionId,
        category_id: data.categoryId,
      });
      await api(recipient).get(`/api/v1/spaces/${spaceId}`).expect(200);
      await api(owner).get(`/api/v1/spaces/${spaceId}`).expect(403);
    });

    it('deletes the space of a sole owner whose departure locks it first, and the acceptance finds nothing', async () => {
      const owner = await person('leave-first-owner');
      const recipient = await person('leave-first-recipient');
      const spaceId = await groupSpace(owner);
      const invite = await inviteTo(owner, spaceId, recipient.email);
      await spaceData(owner, spaceId);

      const [left, accepted] = await overlap(
        testApp.dataSource,
        pauseLockSpace(spaceId),
        LOCK_SPACE,
        () => leave(owner, spaceId),
        () => accept(recipient, { token: tokenOf(invite) }),
      );

      expect(left.status).toBe(200);
      expect([accepted.status, accepted.body.code]).toEqual([404, 'SPACE_INVITE_UNUSABLE']);
      expect(await spaceExists(spaceId)).toBe(false);
      expect(await memberships(spaceId)).toBe(0);
      expect(await invitationsOf(spaceId)).toEqual([]);
      expect((await accept(recipient, { code: invite.code }).expect(404)).body.code).toBe('NOT_FOUND');
      await api(recipient).get(`/api/v1/spaces/${spaceId}`).expect(403);
    });

    it.each([
      ['the owner leaves first', 'owner', 'leaves', [200, 200], ['last']],
      ['the successor leaves first', 'successor', 'leaves', [200, 200], ['last']],
      ['the owner leaves before removing the successor', 'owner', 'is removed', [200, 403], ['successor', 'last']],
      ['the owner removes the successor before leaving', 'successor', 'is removed', [200, 200], ['last']],
    ] as const)(
      'leaves exactly one owner when %s',
      async (_case, first, successorChange, [departureStatus, changeStatus], remaining) => {
        const owner = await person('leave-race-owner');
        const spaceId = await groupSpace(owner);
        const successor = await joined(owner, spaceId, 'leave-race-successor');
        const last = await joined(owner, spaceId, 'leave-race-last');
        const departure = () => leave(owner, spaceId);
        const change = () =>
          successorChange === 'leaves' ? leave(successor, spaceId) : leave(owner, spaceId, successor.userId);

        const [departed, changed] =
          first === 'owner'
            ? await overlap(testApp.dataSource, pauseLockSpace(spaceId), LOCK_MEMBERS, departure, change)
            : (await overlap(testApp.dataSource, pauseLockSpace(spaceId), LOCK_MEMBERS, change, departure)).reverse();

        expect([departed.status, changed.status]).toEqual([departureStatus, changeStatus]);
        const people = { successor, last };
        expect(await roles(spaceId)).toEqual(
          remaining.map((who, index) => ({ user_id: people[who].userId, role: index === 0 ? 'owner' : 'member' })),
        );
      },
    );

    it('keeps one of two spaces deleted at the same time, and the last one', async () => {
      const owner = await person('last-space-owner');
      const groupId = await groupSpace(owner);

      const [first, second] = await overlap(
        testApp.dataSource,
        pauseLockSpace(owner.spaceId),
        LOCK_MEMBERS,
        () => api(owner).delete(`/api/v1/spaces/${owner.spaceId}`),
        () => api(owner).delete(`/api/v1/spaces/${groupId}`),
      );

      expect([first.status, second.status, second.body.code]).toEqual([200, 400, 'SPACE_LAST_REMAINING']);
      expect(await spaceExists(groupId)).toBe(true);

      const left = await leave(owner, groupId).expect(400);
      expect(left.body.code).toBe('SPACE_LAST_REMAINING');
      expect(await roles(groupId)).toEqual([{ user_id: owner.userId, role: 'owner' }]);
    });
  });
});
