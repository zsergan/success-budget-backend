import request from 'supertest';

import { MailService } from '@modules/mail/mail.service';
import { SpaceInviteDelivery } from '@modules/spaces/space-invite-delivery';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SPACE_INVITE_EMAIL } from '@shared/constants';
import { buildConfigService } from '@testing';
import { type Member, type TestApp, createTestApp, createVerifiedMember, deleteUsers } from './support/app';
import { createOpenApiDocument, okResponseSchema, schemaErrors } from './support/openapi';

// Invitations as a recipient gets them: every link and code below is read
// from the email MailDev received (the SMTP_HOST/SMTP_PORT catcher of
// docker-compose.yml and CI), never from the database.
describe('Space invitation email delivery (e2e)', () => {
  let testApp: TestApp;
  const userIds: number[] = [];
  const maildevApiUrl = process.env.MAILDEV_API_URL ?? 'http://127.0.0.1:1080';
  let stamp = 0;

  interface Person extends Member {
    email: string;
  }

  interface ReceivedInvite {
    link: string;
    token: string;
    code: string;
  }

  interface MailDevMessage {
    id: string;
    text: string;
    html: string;
    to?: { address: string }[];
  }

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  beforeEach(() => {
    testApp.resetThrottling();
  });

  afterEach(async () => {
    await delivery().settle();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await deleteUsers(testApp.dataSource, userIds);
    } finally {
      await testApp.app.close();
    }
  });

  const delivery = () => testApp.app.get(SpaceInviteDelivery);
  const address = (label: string) => `e2e-received-${label}-${process.pid}-${Date.now()}-${stamp++}@example.com`;

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

  function groupSpace(owner: Member, invites?: string[], idempotencyKey?: string): request.Test {
    const call = api(owner).post('/api/v1/spaces');

    if (idempotencyKey) {
      call.set('Idempotency-Key', idempotencyKey);
    }

    return call.send({ name: 'Family', currency_id: testApp.currencyId, type: 'group', invites });
  }

  async function messagesTo(to: string): Promise<MailDevMessage[]> {
    const response = await fetch(`${maildevApiUrl}/api/email`);
    const messages: MailDevMessage[] = response.ok ? await response.json() : [];

    return messages.filter((message) => message.to?.some((recipient) => recipient.address === to));
  }

  async function receive(to: string): Promise<ReceivedInvite> {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const [message] = await messagesTo(to);

      if (message) {
        const link = message.text.match(/Open the invitation: (\S+)/)?.[1];
        const code = message.text.match(/enter this code in the app: (\d{6})/)?.[1];

        if (!link || !code) {
          throw new Error(`The invitation email to ${to} has no link or code: ${message.text}`);
        }

        expect(message.html).toContain(`href="${link}"`);
        await fetch(`${maildevApiUrl}/api/email/${message.id}`, { method: 'DELETE' }).catch(() => undefined);

        return { link, code, token: new URL(link).hash.replace(/^#token=/, '') };
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`No invitation email to ${to} appeared in MailDev (${maildevApiUrl}) within 10s`);
  }

  const preview = (member: Member, token: string) => api(member).post('/api/v1/spaces/invites/preview').send({ token });
  const accept = (member: Member, body: object) => api(member).post('/api/v1/spaces/invites/accept').send(body);
  const inviteRow = (spaceId: number, email: string) =>
    testApp.dataSource.getRepository(SpaceInvite).findOneByOrFail({ space_id: spaceId, email });

  // routes the sends to these addresses through an SMTP server that is not there
  function smtpDownFor(addresses: string[] | 'all') {
    const unreachable = new MailService(
      buildConfigService({ SMTP_HOST: '127.0.0.1', SMTP_PORT: 1, MAIL_FROM: 'Down <down@example.com>' }),
    );
    const mail = testApp.app.get(MailService);
    const real = mail.sendSpaceInvite.bind(mail);

    return jest
      .spyOn(mail, 'sendSpaceInvite')
      .mockImplementation((details) =>
        addresses === 'all' || addresses.includes(details.to) ? unreachable.sendSpaceInvite(details) : real(details),
      );
  }

  async function makeDue(spaceId: number, email: string) {
    const invite = await inviteRow(spaceId, email);
    await testApp.dataSource
      .getRepository(SpaceInvite)
      .update(invite.id, { email_next_attempt_at: new Date(Date.now() - 1000) });
    await delivery().processDue();
  }

  async function memberships(spaceId: number, userId: number): Promise<number> {
    const [{ count }] = await testApp.dataSource.query(
      'SELECT COUNT(*) AS count FROM space_members WHERE space_id = ? AND user_id = ?',
      [spaceId, userId],
    );

    return Number(count);
  }

  describe('successful delivery', () => {
    it('emails a standalone invitation whose link previews and joins the space', async () => {
      const owner = await person('received-owner');
      const recipient = await person('received-recipient');
      const space = await groupSpace(owner).expect(201);
      await api(owner).post(`/api/v1/spaces/${space.body.id}/invites`).send({ email: recipient.email }).expect(201);

      const received = await receive(recipient.email);
      expect(received.link.startsWith(`${process.env.PUBLIC_WEB_ORIGIN}/invite#token=`)).toBe(true);

      const shown = await preview(recipient, received.token).expect(200);
      const document = createOpenApiDocument(testApp.app);
      expect(schemaErrors(document, okResponseSchema(document, '/spaces/invites/preview', 'post'), shown.body)).toEqual(
        [],
      );
      expect(shown.body.space.name).toBe('Family');

      const joined = await accept(recipient, { token: received.token }).expect(201);
      expect(joined.body).toMatchObject({ id: space.body.id, name: 'Family' });
      expect(await memberships(space.body.id, recipient.userId)).toBe(1);
    });

    it('emails the invitations of a new space; the emailed code joins like an older client', async () => {
      const owner = await person('received-inline-owner');
      const [byCode, byLink] = [await person('received-inline-code'), await person('received-inline-link')];
      const space = await groupSpace(owner, [byCode.email, byLink.email]).expect(201);

      const [codeMail, linkMail] = [await receive(byCode.email), await receive(byLink.email)];

      const joined = await accept(byCode, { code: codeMail.code }).expect(201);
      expect(Object.keys(joined.body).sort()).toEqual([
        'created_at',
        'currency',
        'currency_id',
        'id',
        'name',
        'type',
        'updated_at',
      ]);
      await accept(byLink, { token: linkMail.token }).expect(201);
      expect(await memberships(space.body.id, byCode.userId)).toBe(1);
      expect(await memberships(space.body.id, byLink.userId)).toBe(1);
    });
  });

  describe('SMTP failures', () => {
    it('keeps the space when one inline email fails, retries it and delivers it once SMTP is back', async () => {
      const owner = await person('received-partial-owner');
      const [fine, failing] = [address('fine'), address('failing')];
      smtpDownFor([failing]);

      const space = await groupSpace(owner, [fine, failing]).expect(201);
      await delivery().settle();

      await expect(receive(fine)).resolves.toMatchObject({ code: expect.stringMatching(/^\d{6}$/) });
      expect(await messagesTo(failing)).toEqual([]);
      await expect(inviteRow(space.body.id, failing)).resolves.toMatchObject({
        email_status: 'queued',
        email_attempts: 1,
      });

      jest.restoreAllMocks();
      await makeDue(space.body.id, failing);
      await expect(receive(failing)).resolves.toMatchObject({ token: expect.stringMatching(/^\d+\./) });
      await expect(inviteRow(space.body.id, failing)).resolves.toMatchObject({ email_status: 'sent' });
    });

    it('shows a persistent outage as failed in the roster; a resend after recovery delivers', async () => {
      const owner = await person('received-outage-owner');
      const recipient = await person('received-outage-recipient');
      const space = await groupSpace(owner).expect(201);
      const send = smtpDownFor('all');

      const created = await api(owner)
        .post(`/api/v1/spaces/${space.body.id}/invites`)
        .send({ email: recipient.email })
        .expect(201);
      await delivery().settle();

      for (let attempt = 2; attempt <= SPACE_INVITE_EMAIL.MAX_ATTEMPTS; attempt++) {
        await makeDue(space.body.id, recipient.email);
      }
      expect(send).toHaveBeenCalledTimes(SPACE_INVITE_EMAIL.MAX_ATTEMPTS);
      expect(await messagesTo(recipient.email)).toEqual([]);

      await testApp.dataSource.query(
        'UPDATE space_invite_emails SET scheduled_at = scheduled_at - INTERVAL 2 MINUTE WHERE invite_id = ?',
        [created.body.id],
      );
      const roster = await api(owner).get(`/api/v1/spaces/${space.body.id}/members`).expect(200);
      expect(roster.body.find((row: { id: number; type: string }) => row.type === 'invite')).toMatchObject({
        id: created.body.id,
        email_status: 'failed',
        can_resend: true,
      });

      jest.restoreAllMocks();
      await api(owner).post(`/api/v1/spaces/${space.body.id}/invites/${created.body.id}/resend`).expect(202);
      const received = await receive(recipient.email);

      expect(received.code).toBe(created.body.code);
      await accept(recipient, { token: received.token }).expect(201);
    });
  });

  describe('retries and wrong use', () => {
    it('sends each invitation once when a lost creation response is repeated with its key', async () => {
      const owner = await person('received-key-owner');
      const invited = address('keyed');
      const key = `create-${process.pid}-${Date.now()}`;

      const first = await groupSpace(owner, [invited], key).expect(201);
      const repeat = await groupSpace(owner, [invited], key).expect(201);
      await delivery().settle();

      expect(repeat.body).toEqual(first.body);
      await receive(invited);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await messagesTo(invited)).toEqual([]);
    });

    it('lets only the invited account use the emailed link and code', async () => {
      const owner = await person('received-wrong-owner');
      const recipient = await person('received-wrong-recipient');
      const stranger = await person('received-wrong-stranger');
      const space = await groupSpace(owner).expect(201);
      await api(owner).post(`/api/v1/spaces/${space.body.id}/invites`).send({ email: recipient.email }).expect(201);
      const received = await receive(recipient.email);

      const previewed = await preview(stranger, received.token).expect(403);
      expect(previewed.body.code).toBe('SPACE_INVITE_EMAIL_MISMATCH');
      expect(JSON.stringify(previewed.body)).not.toContain(recipient.email);
      expect((await accept(stranger, { token: received.token }).expect(403)).body.code).toBe(
        'SPACE_INVITE_EMAIL_MISMATCH',
      );
      expect((await accept(stranger, { code: received.code }).expect(404)).body.code).toBe('NOT_FOUND');
      expect(await memberships(space.body.id, stranger.userId)).toBe(0);

      await accept(recipient, { code: received.code }).expect(201);
    });

    it('stops both emailed credentials of an expired or revoked invitation', async () => {
      const owner = await person('received-ended-owner');
      const [expired, revoked] = [await person('received-expired'), await person('received-revoked')];
      const space = await groupSpace(owner, [expired.email, revoked.email]).expect(201);
      const [expiredMail, revokedMail] = [await receive(expired.email), await receive(revoked.email)];

      const expiredRow = await inviteRow(space.body.id, expired.email);
      await testApp.dataSource
        .getRepository(SpaceInvite)
        .update(expiredRow.id, { expires_at: new Date(Date.now() - 1000) });
      const revokedRow = await inviteRow(space.body.id, revoked.email);
      await api(owner).delete(`/api/v1/spaces/${space.body.id}/invites/${revokedRow.id}`).expect(200);

      for (const [member, mail] of [
        [expired, expiredMail],
        [revoked, revokedMail],
      ] as const) {
        expect((await preview(member, mail.token).expect(404)).body.code).toBe('SPACE_INVITE_UNUSABLE');
        expect((await accept(member, { token: mail.token }).expect(404)).body.code).toBe('SPACE_INVITE_UNUSABLE');
        expect((await accept(member, { code: mail.code }).expect(404)).body.code).toBe('NOT_FOUND');
        expect(await memberships(space.body.id, member.userId)).toBe(0);
      }

      await api(owner).post(`/api/v1/spaces/${space.body.id}/invites/${expiredRow.id}/resend`).expect(404);
    });

    it('joins once when the emailed link and code are confirmed at the same time', async () => {
      const owner = await person('received-race-owner');
      const recipient = await person('received-race-recipient');
      const space = await groupSpace(owner).expect(201);
      await api(owner).post(`/api/v1/spaces/${space.body.id}/invites`).send({ email: recipient.email }).expect(201);
      const received = await receive(recipient.email);

      const results = await Promise.all([
        accept(recipient, { token: received.token }),
        accept(recipient, { code: received.code }),
        accept(recipient, { token: received.token }),
      ]);

      expect(results.map((result) => result.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((result) => result.body.id))).toEqual(new Set([space.body.id]));
      expect(await memberships(space.body.id, recipient.userId)).toBe(1);
    });
  });
});
