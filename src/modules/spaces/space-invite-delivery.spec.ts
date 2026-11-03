import { In, IsNull, LessThanOrEqual, MoreThan, type DataSource, type EntityManager } from 'typeorm';

import { SpaceInviteDelivery, effectiveStatus } from './space-invite-delivery';
import { SpaceInviteLinks } from './space-invite-links';
import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceInviteEmail } from '@entities/space-invite-email.entity';
import { MailDeliveryError, type MailService } from '@modules/mail/mail.service';
import { SpaceInviteEmailStatus } from '@shared/enums';
import { SPACE_INVITE_EMAIL } from '@shared/constants';
import { RetryAfterException } from '@shared/retry-after.exception';
import { buildConfigService, buildSpace, buildSpaceInvite } from '@testing';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const minutes = (count: number) => count * 60_000;

describe('SpaceInviteDelivery', () => {
  let invite: SpaceInvite;
  let claimAffected: number;
  let updates: { criteria: Record<string, unknown>; patch: Record<string, unknown> }[];
  let logRows: SpaceInviteEmail[];
  let sendSpaceInvite: jest.Mock;
  let delivery: SpaceInviteDelivery;

  const links = new SpaceInviteLinks(
    buildConfigService({
      INVITE_TOKEN_SECRET: 'invite-token-secret-for-unit-tests-only',
      PUBLIC_WEB_ORIGIN: 'https://app.example.com',
    }),
  );

  // The row after a claim: the claim itself is a conditional SQL update,
  // covered against MySQL in the e2e spec.
  const claimed = (overrides: Partial<SpaceInvite> = {}) =>
    buildSpaceInvite({
      id: 7,
      space_id: 3,
      email: 'anna@example.com',
      code: '042917',
      expires_at: new Date(Date.now() + minutes(60 * 24)),
      email_status: SpaceInviteEmailStatus.SENDING,
      email_attempts: 1,
      email_attempt_id: 4,
      email_lease_expires_at: new Date(Date.now() + SPACE_INVITE_EMAIL.LEASE_MS),
      ...overrides,
    });

  const inviteRepository = {
    findOne: jest.fn(async () => invite),
    update: jest.fn(async (criteria: Record<string, unknown>, patch: Record<string, unknown>) => {
      updates.push({ criteria, patch });
      const current = typeof criteria === 'object' && criteria.email_attempt_id === invite.email_attempt_id;

      return { affected: current ? 1 : 0 };
    }),
    find: jest.fn(async () => []),
  };
  const logRepository = {
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      logRows.filter((row) =>
        Object.entries(where).every(
          ([key, value]) => key === 'scheduled_at' || row[key as keyof SpaceInviteEmail] === value,
        ),
      ),
    ),
    insert: jest.fn(),
  };
  const repositoryFor = (entity: unknown) => {
    if (entity === SpaceInvite) return inviteRepository;
    if (entity === SpaceInviteEmail) return logRepository;
    if (entity === Space) return { findOne: async () => buildSpace({ id: 3, name: 'Family' }) };
    throw new Error(`Unexpected entity: ${String(entity)}`);
  };
  let builderUpdates: { set: unknown; where: unknown[] }[];
  const updateBuilder = () => {
    const recorded = { set: undefined as unknown, where: [] as unknown[] };
    builderUpdates.push(recorded);
    const builder = {
      update: () => builder,
      set: (values: unknown) => ((recorded.set = values), builder),
      where: (condition: unknown) => (recorded.where.push(condition), builder),
      andWhere: (condition: unknown) => (recorded.where.push(condition), builder),
      execute: async () => ({ affected: claimAffected }),
    };

    return builder;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    invite = claimed();
    claimAffected = 1;
    updates = [];
    builderUpdates = [];
    logRows = [];
    sendSpaceInvite = jest.fn();
    const dataSource = {
      getRepository: repositoryFor,
      createQueryBuilder: updateBuilder,
      query: jest.fn(),
    } as unknown as DataSource;
    delivery = new SpaceInviteDelivery(dataSource, { sendSpaceInvite } as unknown as MailService, links);
  });

  const lastPatch = () => updates[updates.length - 1];

  describe('attempt', () => {
    it('sends the invitation and records it as sent while it is still this attempt', async () => {
      await expect(delivery.attempt(7)).resolves.toBe('sent');

      expect(sendSpaceInvite).toHaveBeenCalledWith({
        to: 'anna@example.com',
        spaceName: 'Family',
        link: links.link(invite),
        code: '042917',
        expiresAt: invite.expires_at,
      });
      expect(lastPatch()).toEqual({
        criteria: {
          id: 7,
          email_attempt_id: 4,
          email_status: SpaceInviteEmailStatus.SENDING,
          accepted_at: IsNull(),
          revoked_at: IsNull(),
          expires_at: MoreThan(expect.any(Date)),
        },
        patch: {
          email_status: SpaceInviteEmailStatus.SENT,
          email_lease_expires_at: null,
          email_next_attempt_at: null,
          email_last_sent_at: expect.any(Date),
        },
      });
    });

    it('does nothing when another worker holds the row or it is not due', async () => {
      claimAffected = 0;

      await expect(delivery.attempt(7)).resolves.toBe('skipped');
      expect(sendSpaceInvite).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    });

    it('schedules a retry after a temporary failure, with the bounded backoff', async () => {
      for (const [attempts, delay] of SPACE_INVITE_EMAIL.RETRY_DELAYS_MS.map((ms, index) => [index + 1, ms])) {
        invite = claimed({ email_attempts: attempts });
        sendSpaceInvite.mockRejectedValueOnce(new MailDeliveryError(false, 'ETIMEDOUT'));
        const before = Date.now();

        await expect(delivery.attempt(7)).resolves.toBe('retry');

        const { patch } = lastPatch();
        expect(patch).toMatchObject({ email_status: SpaceInviteEmailStatus.QUEUED, email_lease_expires_at: null });
        const next = (patch.email_next_attempt_at as Date).getTime();
        expect(next).toBeGreaterThanOrEqual(before + delay);
        expect(next).toBeLessThanOrEqual(Date.now() + delay);
      }
    });

    it('fails for good after the last attempt or a permanent rejection', async () => {
      invite = claimed({ email_attempts: SPACE_INVITE_EMAIL.MAX_ATTEMPTS });
      sendSpaceInvite.mockRejectedValueOnce(new MailDeliveryError(false, 'ETIMEDOUT'));
      await expect(delivery.attempt(7)).resolves.toBe('failed');
      expect(lastPatch().patch).toMatchObject({
        email_status: SpaceInviteEmailStatus.FAILED,
        email_next_attempt_at: null,
      });

      invite = claimed({ email_attempts: 1 });
      sendSpaceInvite.mockRejectedValueOnce(new MailDeliveryError(true, 'smtp 550'));
      await expect(delivery.attempt(7)).resolves.toBe('failed');
      expect(lastPatch().patch).toMatchObject({ email_status: SpaceInviteEmailStatus.FAILED });
    });

    it('treats an unexpected error as a temporary failure', async () => {
      sendSpaceInvite.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(delivery.attempt(7)).resolves.toBe('retry');
    });

    it('gives up without sending when lost leases used up the attempts', async () => {
      invite = claimed({ email_attempts: SPACE_INVITE_EMAIL.MAX_ATTEMPTS + 1 });

      await expect(delivery.attempt(7)).resolves.toBe('failed');
      expect(sendSpaceInvite).not.toHaveBeenCalled();
      expect(lastPatch().patch).toMatchObject({ email_status: SpaceInviteEmailStatus.FAILED });
    });

    it('writes nothing over a newer state: the update requires its own attempt id', async () => {
      sendSpaceInvite.mockImplementationOnce(async () => {
        invite = { ...invite, email_attempt_id: invite.email_attempt_id + 1 } as SpaceInvite;
      });

      await expect(delivery.attempt(7)).resolves.toBe('sent');
      expect(lastPatch().criteria).toMatchObject({ email_attempt_id: 4 });
      expect(inviteRepository.update.mock.results[0].value).resolves.toEqual({ affected: 0 });
    });

    it('does not send for an invitation that ended while it was claimed', async () => {
      invite = claimed({ revoked_at: new Date() });

      await expect(delivery.attempt(7)).resolves.toBe('skipped');
      expect(sendSpaceInvite).not.toHaveBeenCalled();
    });
  });

  describe('processDue', () => {
    it('first takes ended invitations out of the queue, then picks only active due ones', async () => {
      await expect(delivery.processDue(NOW)).resolves.toBe(0);

      expect(builderUpdates).toEqual([
        {
          set: { email_next_attempt_at: null, email_lease_expires_at: null },
          where: [
            'email_status IN (:...pending)',
            '(email_next_attempt_at IS NOT NULL OR email_lease_expires_at IS NOT NULL)',
            '(accepted_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= :now)',
          ],
        },
      ]);
      expect(inviteRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            email_status: In([SpaceInviteEmailStatus.QUEUED, SpaceInviteEmailStatus.SENDING]),
            email_next_attempt_at: LessThanOrEqual(NOW),
            accepted_at: IsNull(),
            revoked_at: IsNull(),
            expires_at: MoreThan(NOW),
          },
          take: SPACE_INVITE_EMAIL.POLL_BATCH,
        }),
      );
    });
  });

  describe('assertCanSchedule', () => {
    const manager = { getRepository: repositoryFor } as unknown as EntityManager;
    const sent = (ago: number, overrides: Partial<SpaceInviteEmail> = {}) =>
      logRows.push(
        Object.assign(new SpaceInviteEmail(), {
          invite_id: 7,
          space_id: 3,
          email: 'anna@example.com',
          sender_user_id: 1,
          scheduled_at: new Date(NOW.getTime() - ago),
          ...overrides,
        }),
      );
    const retryAfter = (request: Parameters<SpaceInviteDelivery['assertCanSchedule']>[1]) =>
      delivery.assertCanSchedule(manager, request, NOW).then(
        () => 0,
        (error: RetryAfterException) => error.retryAfterSeconds,
      );
    const resend = { senderId: 1, spaceId: 3, emails: ['anna@example.com'], inviteId: 7 };

    it('allows a first email', async () => {
      await expect(retryAfter(resend)).resolves.toBe(0);
    });

    it('refuses within 60 seconds of the invitation’s last email, with the rest of it', async () => {
      sent(minutes(10));
      sent(20_000);

      await expect(retryAfter(resend)).resolves.toBe(40);
      await expect(delivery.assertCanSchedule(manager, resend, NOW)).rejects.toBeInstanceOf(RetryAfterException);
    });

    it('refuses a sixth email of an invitation in 24 hours until the oldest leaves the window', async () => {
      [minutes(600), minutes(400), minutes(300), minutes(200), minutes(100)].forEach((ago) => sent(ago));

      await expect(retryAfter(resend)).resolves.toBe((24 * 60 - 600) * 60);
    });

    it('limits one address across spaces and senders', async () => {
      for (let i = 0; i < SPACE_INVITE_EMAIL.PER_RECIPIENT; i++) {
        sent(minutes(30 + i), { invite_id: 100 + i, space_id: 100 + i, sender_user_id: 100 + i });
      }

      await expect(retryAfter({ senderId: 1, spaceId: 3, emails: ['anna@example.com'] })).resolves.toBeGreaterThan(0);
      await expect(retryAfter({ senderId: 1, spaceId: 3, emails: ['ben@example.com'] })).resolves.toBe(0);
    });

    it('limits a space and a sender, counting the emails being added', async () => {
      for (let i = 0; i < SPACE_INVITE_EMAIL.PER_SPACE - 1; i++) {
        sent(minutes(30), { invite_id: 100 + i, email: `u${i}@example.com`, sender_user_id: 2 });
      }

      await expect(retryAfter({ senderId: 1, spaceId: 3, emails: ['x@example.com'] })).resolves.toBe(0);
      await expect(
        retryAfter({ senderId: 1, spaceId: 3, emails: ['x@example.com', 'y@example.com'] }),
      ).resolves.toBeGreaterThan(0);
      await expect(
        retryAfter({ senderId: 2, spaceId: null, emails: Array.from({ length: 22 }, (_, i) => `n${i}@example.com`) }),
      ).resolves.toBeGreaterThan(0);
    });
  });

  describe('describe', () => {
    it('reports the cooldown and an expired lease as queued', async () => {
      const recent = buildSpaceInvite({ id: 7, email_status: SpaceInviteEmailStatus.SENT });
      const lost = buildSpaceInvite({
        id: 8,
        email_status: SpaceInviteEmailStatus.SENDING,
        email_lease_expires_at: new Date(NOW.getTime() - 1),
      });
      const legacy = buildSpaceInvite({ id: 9, email_status: SpaceInviteEmailStatus.NOT_SENT, token_nonce: null });
      logRows.push(
        Object.assign(new SpaceInviteEmail(), { invite_id: 7, scheduled_at: new Date(NOW.getTime() - 15_000) }),
      );
      jest.spyOn(logRepository, 'find').mockResolvedValueOnce(logRows);

      const views = await delivery.describe([recent, lost, legacy], NOW);

      expect(Object.fromEntries(views)).toEqual({
        7: { email_status: SpaceInviteEmailStatus.SENT, resend_after_seconds: 45 },
        8: { email_status: SpaceInviteEmailStatus.QUEUED, resend_after_seconds: 0 },
        9: { email_status: SpaceInviteEmailStatus.NOT_SENT, resend_after_seconds: 0 },
      });
    });

    it('keeps a running attempt as sending', () => {
      expect(
        effectiveStatus(
          { email_status: SpaceInviteEmailStatus.SENDING, email_lease_expires_at: new Date(NOW.getTime() + 1) },
          NOW,
        ),
      ).toBe(SpaceInviteEmailStatus.SENDING);
    });
  });

  describe('lifecycle', () => {
    it('waits for in-flight attempts on shutdown and starts none afterwards', async () => {
      let finishSend!: () => void;
      sendSpaceInvite.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSend = resolve)));
      delivery.deliverSoon([7]);
      await new Promise((resolve) => setImmediate(resolve));

      let settled = false;
      const shutdown = delivery.beforeApplicationShutdown().then(() => (settled = true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      finishSend();
      await shutdown;
      expect(lastPatch().patch).toMatchObject({ email_status: SpaceInviteEmailStatus.SENT });

      delivery.deliverSoon([7]);
      await expect(delivery.processDue()).resolves.toBe(0);
      expect(sendSpaceInvite).toHaveBeenCalledTimes(1);
    });
  });
});
