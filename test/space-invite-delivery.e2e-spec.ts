import request from 'supertest';
import { In } from 'typeorm';

import { MailDeliveryError, MailService } from '@modules/mail/mail.service';
import { SpaceInviteDelivery } from '@modules/spaces/space-invite-delivery';
import { newInviteTokenNonce } from '@modules/spaces/space-invite-links';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SPACE_INVITE_EMAIL } from '@shared/constants';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';

const MAILDEV = process.env.MAILDEV_API_URL ?? 'http://127.0.0.1:1080';

interface MailDevMessage {
  id: string;
  subject: string;
  text: string;
  html: string;
  to?: { address: string }[];
}

describe('Space invitation emails (e2e)', () => {
  let testApp: TestApp;
  let other: TestApp;
  const userIds: number[] = [];
  let stamp = 0;

  beforeAll(async () => {
    testApp = await createTestApp();
    other = await createTestApp();
  });

  beforeEach(() => {
    testApp.resetThrottling();
  });

  afterEach(async () => {
    await delivery().settle();
    await delivery(other).settle();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await other.app.close();
      await testApp.app.close();
    }
  });

  const delivery = (app = testApp) => app.app.get(SpaceInviteDelivery);
  const mail = (app = testApp) => app.app.get(MailService);
  const address = (label: string) => `e2e-invite-${label}-${process.pid}-${Date.now()}-${stamp++}@example.com`;

  async function person(prefix: string): Promise<Member & { email: string }> {
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

  async function invite(owner: Member, spaceId: number, email = address('to')) {
    const response = await api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email }).expect(201);

    return response.body as { id: number; email: string; code: string; email_status: string };
  }

  const row = (id: number) => testApp.dataSource.getRepository(SpaceInvite).findOneByOrFail({ id });
  const setRow = (id: number, values: Record<string, unknown>) =>
    testApp.dataSource.getRepository(SpaceInvite).update(id, values);
  const ago = (ms: number) => new Date(Date.now() - ms);

  // ages every send-log row of the invitation, as if its emails were older
  const ageLog = (inviteId: number, ms: number) =>
    testApp.dataSource.query(
      'UPDATE space_invite_emails SET scheduled_at = scheduled_at - INTERVAL ? MICROSECOND WHERE invite_id = ?',
      [ms * 1000, inviteId],
    );

  async function mailTo(to: string): Promise<MailDevMessage> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const response = await fetch(`${MAILDEV}/api/email`);

      if (response.ok) {
        const messages: MailDevMessage[] = await response.json();
        const match = messages.find((message) => message.to?.some((recipient) => recipient.address === to));

        if (match) {
          return match;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`No email to ${to} appeared in MailDev within 10s`);
  }

  // holds every send until release() or fail(); sent resolves once the first one started
  function holdSends() {
    let release!: () => void;
    let fail!: (error: Error) => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve, reject) => ((release = resolve), (fail = reject)));
    const sent = new Promise<void>((resolve) => (started = resolve));
    const spy = jest.spyOn(mail(), 'sendSpaceInvite').mockImplementation(async () => {
      started();
      await gate;
    });

    return { spy, sent, release, fail };
  }

  describe('delivery', () => {
    it('emails a new invitation through SMTP with a link that keeps its token', async () => {
      const owner = await person('mail-owner');
      const recipient = await person('mail-recipient');
      const spaceId = await groupSpace(owner);
      const created = await invite(owner, spaceId, recipient.email);
      expect(created.email_status).toBe('queued');

      await delivery().settle();
      const message = await mailTo(recipient.email);
      const link = message.text.match(/Open the invitation: (\S+)/)?.[1] as string;

      expect(message.subject).toBe('You are invited to "Family" in Success Budget');
      expect(link.startsWith(`${process.env.PUBLIC_WEB_ORIGIN}/invite#token=${created.id}.`)).toBe(true);
      expect(message.html).toContain(`href="${link}"`);
      expect(message.text).toContain(`enter this code in the app: ${created.code}`);
      expect(message.text).toContain(recipient.email);

      const token = new URL(link).hash.replace('#token=', '');
      await api(recipient).post('/api/v1/spaces/invites/preview').send({ token }).expect(200);
      await expect(row(created.id)).resolves.toMatchObject({
        email_status: 'sent',
        email_attempts: 1,
        email_last_sent_at: expect.any(Date),
        email_lease_expires_at: null,
        email_next_attempt_at: null,
      });

      await fetch(`${MAILDEV}/api/email/${message.id}`, { method: 'DELETE' }).catch(() => undefined);
    });

    it('emails the invitations created with a space', async () => {
      const owner = await person('mail-inline');
      const emails = [address('inline-1'), address('inline-2')];
      const spaceId = await groupSpace(owner, emails);

      await delivery().settle();

      for (const email of emails) {
        await expect(mailTo(email)).resolves.toMatchObject({ subject: expect.stringContaining('Family') });
      }
      const rows = await testApp.dataSource.getRepository(SpaceInvite).findBy({ space_id: spaceId });
      expect(rows.map((stored) => stored.email_status)).toEqual(['sent', 'sent']);
    });

    it('recovers an attempt whose lease ran out, as after a crash, on another instance', async () => {
      const owner = await person('mail-recover');
      const spaceId = await groupSpace(owner);
      const { sent, release } = holdSends();
      const created = await invite(owner, spaceId);
      await sent;
      release();
      await delivery().settle();
      jest.restoreAllMocks();
      await setRow(created.id, {
        email_status: 'sending',
        email_attempts: 1,
        email_lease_expires_at: ago(1000),
        email_next_attempt_at: ago(1000),
        email_last_sent_at: null,
      });
      const recovered = jest.spyOn(mail(other), 'sendSpaceInvite');

      await delivery(other).processDue();

      expect(recovered).toHaveBeenCalledTimes(1);
      await expect(row(created.id)).resolves.toMatchObject({ email_status: 'sent', email_attempts: 2 });
    });

    it('leaves an attempt alone while its lease runs', async () => {
      const owner = await person('mail-lease');
      const spaceId = await groupSpace(owner);
      const { sent, release } = holdSends();
      const created = await invite(owner, spaceId);
      await sent;

      const competing = jest.spyOn(mail(other), 'sendSpaceInvite');
      await expect(delivery(other).attempt(created.id)).resolves.toBe('skipped');
      await delivery(other).processDue();

      expect(competing).not.toHaveBeenCalled();
      await expect(row(created.id)).resolves.toMatchObject({ email_status: 'sending', email_attempts: 1 });
      release();
    });

    it('lets one of two competing workers send a due email', async () => {
      const owner = await person('mail-compete');
      const spaceId = await groupSpace(owner);
      const { sent, release } = holdSends();
      const created = await invite(owner, spaceId);
      await sent;
      release();
      await delivery().settle();
      jest.restoreAllMocks();
      await setRow(created.id, { email_status: 'queued', email_attempts: 0, email_next_attempt_at: ago(1000) });
      const here = jest.spyOn(mail(), 'sendSpaceInvite');
      const there = jest.spyOn(mail(other), 'sendSpaceInvite');

      const outcomes = await Promise.all([delivery().attempt(created.id), delivery(other).attempt(created.id)]);

      expect(outcomes.sort()).toEqual(['sent', 'skipped']);
      expect(here.mock.calls.length + there.mock.calls.length).toBe(1);
      await expect(row(created.id)).resolves.toMatchObject({ email_status: 'sent', email_attempts: 1 });
    });

    it('drops the result of an attempt that a revocation overtook', async () => {
      const owner = await person('mail-stale');
      const spaceId = await groupSpace(owner);
      const { sent, release } = holdSends();
      const created = await invite(owner, spaceId);
      await sent;

      await api(owner).delete(`/api/v1/spaces/${spaceId}/invites/${created.id}`).expect(200);
      release();
      await delivery().settle();

      const stored = await row(created.id);
      expect(stored.revoked_at).toBeInstanceOf(Date);
      expect(stored).toMatchObject({ email_status: 'sending', email_last_sent_at: null, email_next_attempt_at: null });
    });

    it.each([
      [
        'fails temporarily',
        (held: ReturnType<typeof holdSends>) => held.fail(new MailDeliveryError(false, 'ECONNRESET')),
      ],
      ['is accepted by SMTP', (held: ReturnType<typeof holdSends>) => held.release()],
    ])('keeps an accepted invitation out of the queue when its running attempt then %s', async (_case, complete) => {
      const owner = await person('mail-accepted');
      const recipient = await person('mail-accepted-to');
      const spaceId = await groupSpace(owner);
      const held = holdSends();
      const created = await invite(owner, spaceId, recipient.email);
      await held.sent;
      const running = await row(created.id);
      expect(running).toMatchObject({ email_status: 'sending', email_attempts: 1 });

      await api(recipient).post('/api/v1/spaces/invites/accept').send({ code: created.code }).expect(201);
      complete(held);
      await delivery().settle();

      const ended = {
        accepted_by_user_id: recipient.userId,
        email_status: 'sending',
        email_attempts: 1,
        email_attempt_id: running.email_attempt_id + 1,
        email_next_attempt_at: null,
        email_lease_expires_at: null,
        email_last_sent_at: null,
      };
      const stored = await row(created.id);
      expect(stored.accepted_at).toBeInstanceOf(Date);
      expect(stored).toMatchObject(ended);

      held.spy.mockClear();
      await delivery().processDue();
      await delivery(other).attempt(created.id);
      expect(held.spy).not.toHaveBeenCalledWith(expect.objectContaining({ to: recipient.email }));
      await expect(row(created.id)).resolves.toMatchObject(ended);
    });

    it('clears ended invitations that fill a whole batch and still sends the active one behind them', async () => {
      const owner = await person('mail-poisoned');
      const spaceId = await groupSpace(owner);
      const days = (count: number) => count * 24 * 60 * 60_000;
      const ended = Array.from({ length: SPACE_INVITE_EMAIL.POLL_BATCH + 3 }, (_, i) => {
        const end = [
          { accepted_at: ago(days(1)), email_status: 'queued' },
          { revoked_at: ago(days(1)), email_status: 'sending', email_lease_expires_at: ago(days(10)) },
          { expires_at: ago(days(1)), email_status: 'sending', email_lease_expires_at: new Date(Date.now() + 60_000) },
        ][i % 3];

        return {
          space_id: spaceId,
          email: address(`poisoned-${i}`),
          code: '000000',
          expires_at: new Date(Date.now() + days(1)),
          token_nonce: newInviteTokenNonce(),
          email_next_attempt_at: ago(days(10) + i * 1000),
          ...end,
        };
      });
      const active = {
        space_id: spaceId,
        email: address('behind'),
        code: '000001',
        expires_at: new Date(Date.now() + days(1)),
        token_nonce: newInviteTokenNonce(),
        email_status: 'queued',
        email_next_attempt_at: ago(days(9)),
      };
      const repository = testApp.dataSource.getRepository(SpaceInvite);
      await repository.insert([...ended, active] as Partial<SpaceInvite>[]);
      const send = jest.spyOn(mail(), 'sendSpaceInvite').mockResolvedValue(undefined);

      await delivery().processDue();

      expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: active.email }));
      await expect(repository.findOneByOrFail({ email: active.email })).resolves.toMatchObject({
        email_status: 'sent',
        email_attempts: 1,
      });
      const cleared = await repository.findBy({ space_id: spaceId, email: In(ended.map((entry) => entry.email)) });
      expect(cleared).toHaveLength(ended.length);
      for (const entry of cleared) {
        expect(entry).toMatchObject({ email_next_attempt_at: null, email_lease_expires_at: null, email_attempts: 0 });
        expect(['queued', 'sending']).toContain(entry.email_status);
      }
    });

    it('sends nothing for revoked, accepted or expired invitations and drops them from the queue', async () => {
      const owner = await person('mail-ended');
      const spaceId = await groupSpace(owner);
      const ids: number[] = [];

      for (let i = 0; i < 3; i++) {
        ids.push((await invite(owner, spaceId)).id);
      }
      await delivery().settle();
      const due = { email_status: 'queued', email_attempts: 0, email_next_attempt_at: ago(1000) };
      await setRow(ids[0], { ...due, revoked_at: new Date() });
      await setRow(ids[1], { ...due, accepted_at: new Date() });
      await setRow(ids[2], { ...due, expires_at: ago(1000) });
      const send = jest.spyOn(mail(), 'sendSpaceInvite');

      await delivery().processDue();
      await Promise.all(ids.map((id) => delivery().attempt(id)));

      expect(send).not.toHaveBeenCalled();
      for (const id of ids) {
        await expect(row(id)).resolves.toMatchObject({ email_status: 'queued', email_next_attempt_at: null });
      }
    });
  });

  describe('failures', () => {
    it('retries a temporary failure, then shows a persistent one in the roster and sends it on resend', async () => {
      const owner = await person('mail-fail');
      const spaceId = await groupSpace(owner);
      const failing = jest
        .spyOn(mail(), 'sendSpaceInvite')
        .mockRejectedValue(new MailDeliveryError(false, 'ECONNREFUSED'));
      const created = await invite(owner, spaceId);
      await delivery().settle();

      const retried = await row(created.id);
      expect(retried).toMatchObject({ email_status: 'queued', email_attempts: 1 });
      expect((retried.email_next_attempt_at as Date).getTime()).toBeGreaterThan(
        Date.now() + SPACE_INVITE_EMAIL.RETRY_DELAYS_MS[0] - 5000,
      );

      await setRow(created.id, { email_attempts: SPACE_INVITE_EMAIL.MAX_ATTEMPTS - 1, email_next_attempt_at: ago(1) });
      await delivery().attempt(created.id);
      await expect(row(created.id)).resolves.toMatchObject({ email_status: 'failed', email_next_attempt_at: null });
      expect(failing).toHaveBeenCalledTimes(2);

      await ageLog(created.id, 2 * 60_000);
      const roster = await api(owner).get(`/api/v1/spaces/${spaceId}/members`).expect(200);
      expect(roster.body.find((entry: { id: number; type: string }) => entry.type === 'invite')).toMatchObject({
        id: created.id,
        email_status: 'failed',
        can_resend: true,
        resend_after_seconds: 0,
      });

      failing.mockRestore();
      const resent = await api(owner).post(`/api/v1/spaces/${spaceId}/invites/${created.id}/resend`).expect(202);
      expect(resent.body).toEqual({
        id: created.id,
        email: created.email,
        expires_at: expect.any(String),
        email_status: 'queued',
        resend_after_seconds: 60,
      });
      await delivery().settle();
      await expect(row(created.id)).resolves.toMatchObject({ email_status: 'sent', email_attempts: 1 });
      await expect(mailTo(created.email)).resolves.toMatchObject({ text: expect.stringContaining(created.code) });
    });
  });

  describe('limits', () => {
    it('enforces the resend cooldown and the emails per invitation', async () => {
      const owner = await person('mail-cooldown');
      const spaceId = await groupSpace(owner);
      const created = await invite(owner, spaceId);
      await delivery().settle();
      const resend = () => api(owner).post(`/api/v1/spaces/${spaceId}/invites/${created.id}/resend`);

      const early = await resend().expect(429);
      expect(early.body).toMatchObject({ code: 'SPACE_INVITE_RATE_LIMITED', retryAfterSeconds: expect.any(Number) });
      expect(Number(early.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(early.headers['retry-after'])).toBeLessThanOrEqual(60);

      for (let email = 2; email <= SPACE_INVITE_EMAIL.PER_INVITE; email++) {
        await ageLog(created.id, 2 * 60_000);
        await resend().expect(202);
        await delivery().settle();
      }

      await ageLog(created.id, 2 * 60_000);
      const capped = await resend().expect(429);
      expect(Number(capped.headers['retry-after'])).toBeGreaterThan(23 * 60 * 60);

      const [{ count }] = await testApp.dataSource.query(
        'SELECT COUNT(*) AS count FROM space_invite_emails WHERE invite_id = ?',
        [created.id],
      );
      expect(Number(count)).toBe(SPACE_INVITE_EMAIL.PER_INVITE);
    });

    it('limits one address across spaces and senders, also for invitations created with a space', async () => {
      const owner = await person('mail-recipient-limit');
      const spaceId = await groupSpace(owner);
      const target = address('popular');
      const rows = Array.from({ length: SPACE_INVITE_EMAIL.PER_RECIPIENT }, (_, i) => [
        -1,
        -1,
        target,
        owner.userId,
        ago(60_000 * (i + 1)),
      ]);
      await testApp.dataSource.query(
        'INSERT INTO space_invite_emails (invite_id, space_id, email, sender_user_id, scheduled_at) VALUES ?',
        [rows],
      );

      const direct = await api(owner).post(`/api/v1/spaces/${spaceId}/invites`).send({ email: target }).expect(429);
      expect(direct.body.code).toBe('SPACE_INVITE_RATE_LIMITED');

      const name = `Limited ${Date.now()}`;
      const inline = await api(owner)
        .post('/api/v1/spaces')
        .send({ name, currency_id: testApp.currencyId, type: 'group', invites: [address('fine'), target] })
        .expect(429);
      expect(inline.body.code).toBe('SPACE_INVITE_RATE_LIMITED');

      const [{ spaces }] = await testApp.dataSource.query('SELECT COUNT(*) AS spaces FROM spaces WHERE name = ?', [
        name,
      ]);
      expect(Number(spaces)).toBe(0);
      expect(await testApp.dataSource.getRepository(SpaceInvite).countBy({ space_id: spaceId })).toBe(0);
    });
  });
});
