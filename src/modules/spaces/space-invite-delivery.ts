import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Brackets, DataSource, EntityManager, In, LessThanOrEqual, MoreThan } from 'typeorm';

import { Space } from '@entities/space.entity';
import { SpaceInvite } from '@entities/space-invite.entity';
import { SpaceInviteEmail } from '@entities/space-invite-email.entity';
import { SpaceInviteEmailStatus } from '@shared/enums';
import { SPACE_INVITE_EMAIL } from '@shared/constants';
import { RetryAfterException } from '@shared/retry-after.exception';
import { MailDeliveryError, MailService } from '@modules/mail/mail.service';
import { SpaceInviteLinks, newInviteTokenNonce } from './space-invite-links';
import { isActiveInvite } from './space-invite-state';

export interface ScheduleRequest {
  senderId: number;
  // null for a space created in the same transaction: it has no history
  spaceId: number | null;
  emails: string[];
  inviteId?: number;
}

export interface InviteDeliveryView {
  email_status: SpaceInviteEmailStatus;
  resend_after_seconds: number;
}

export type AttemptOutcome = 'skipped' | 'sent' | 'retry' | 'failed';

const {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  LEASE_MS,
  POLL_INTERVAL_MS,
  POLL_BATCH,
  RESEND_COOLDOWN_MS,
  LIMIT_WINDOW_MS,
  PER_INVITE,
  PER_RECIPIENT,
  PER_SPACE,
  PER_SENDER,
} = SPACE_INVITE_EMAIL;
const PURGE_BATCH = 1000;

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

// Invitation rows are the delivery queue. Scheduling writes the row's
// delivery state and a send-log row inside the caller's transaction; the
// email is sent only after the commit, by deliverSoon() or by the periodic
// run that also recovers attempts whose lease ran out (a crash, a restart).
// An attempt claims the row with a conditional update and a lease, sends
// with no transaction open, and writes its result only while the row still
// carries its attempt id. A crash after the SMTP server accepted the message
// but before the result was written sends it again: the same link and code.
@Injectable()
export class SpaceInviteDelivery implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(SpaceInviteDelivery.name);
  private readonly inFlight = new Set<Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailService: MailService,
    private readonly links: SpaceInviteLinks,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.track(this.processDue()), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.settle();
  }

  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  // Refuses with 429 SPACE_INVITE_RATE_LIMITED when scheduling these emails
  // would exceed a limit. Retry-After is when the oldest counted email leaves
  // the window. Callers hold the space lock, so the invitation and space
  // limits are exact; the address and sender limits span spaces and can be
  // passed by requests that run at the same moment.
  async assertCanSchedule(manager: EntityManager, request: ScheduleRequest, now = new Date()): Promise<void> {
    const since = new Date(now.getTime() - LIMIT_WINDOW_MS);
    const waits: number[] = [];
    const log = manager.getRepository(SpaceInviteEmail);
    const windowOf = async (where: Partial<SpaceInviteEmail>) => {
      const rows = await log.find({
        where: { ...where, scheduled_at: MoreThan(since) },
        order: { scheduled_at: 'ASC' },
        select: { scheduled_at: true },
      });

      return rows.map((row) => row.scheduled_at);
    };
    const limitWait = (times: Date[], limit: number, adding: number) =>
      times.length + adding > limit ? times[0].getTime() + LIMIT_WINDOW_MS - now.getTime() : 0;

    if (request.inviteId !== undefined) {
      const times = await windowOf({ invite_id: request.inviteId });
      const last = times[times.length - 1];

      waits.push(last ? last.getTime() + RESEND_COOLDOWN_MS - now.getTime() : 0);
      waits.push(limitWait(times, PER_INVITE, 1));
    }

    if (request.spaceId !== null) {
      waits.push(limitWait(await windowOf({ space_id: request.spaceId }), PER_SPACE, request.emails.length));
    }

    waits.push(limitWait(await windowOf({ sender_user_id: request.senderId }), PER_SENDER, request.emails.length));

    for (const email of new Set(request.emails)) {
      waits.push(limitWait(await windowOf({ email }), PER_RECIPIENT, 1));
    }

    const wait = Math.max(...waits);

    if (wait > 0) {
      throw new RetryAfterException('SPACE_INVITE_RATE_LIMITED', Math.max(1, seconds(wait)));
    }
  }

  // Records emails of invitations whose rows already carry the queued state
  // (new invitations) in the send log.
  async recordScheduled(manager: EntityManager, senderId: number, invites: SpaceInvite[], now = new Date()) {
    if (invites.length === 0) {
      return;
    }

    await manager.getRepository(SpaceInviteEmail).insert(
      invites.map((invite) => ({
        invite_id: invite.id,
        space_id: invite.space_id,
        email: invite.email,
        sender_user_id: senderId,
        scheduled_at: now,
      })),
    );
  }

  // A new email for an existing invitation: a fresh attempt budget, due now.
  // A legacy invitation gets its link here. The attempt id moves on, so a
  // result of an earlier attempt can no longer be written.
  async requeue(manager: EntityManager, senderId: number, invite: SpaceInvite, now = new Date()): Promise<void> {
    const patch = {
      token_nonce: invite.token_nonce ?? newInviteTokenNonce(),
      email_status: SpaceInviteEmailStatus.QUEUED,
      email_attempts: 0,
      email_next_attempt_at: now,
      email_lease_expires_at: null,
    };

    await manager
      .getRepository(SpaceInvite)
      .update(invite.id, { ...patch, email_attempt_id: () => 'email_attempt_id + 1' });
    Object.assign(invite, patch);
    await this.recordScheduled(manager, senderId, [invite], now);
  }

  // Moves a queued email's next attempt to now; nothing is added to the log.
  async expedite(manager: EntityManager, invite: SpaceInvite, now = new Date()): Promise<void> {
    await manager.getRepository(SpaceInvite).update(invite.id, { email_next_attempt_at: now });
    invite.email_next_attempt_at = now;
  }

  async describe(invites: SpaceInvite[], now = new Date()): Promise<Map<number, InviteDeliveryView>> {
    const views = new Map<number, InviteDeliveryView>();

    if (invites.length === 0) {
      return views;
    }

    const rows: SpaceInviteEmail[] = await this.dataSource.getRepository(SpaceInviteEmail).find({
      where: {
        invite_id: In(invites.map((invite) => invite.id)),
        scheduled_at: MoreThan(new Date(now.getTime() - LIMIT_WINDOW_MS)),
      },
      order: { scheduled_at: 'ASC' },
    });

    for (const invite of invites) {
      const times = rows.filter((row) => row.invite_id === invite.id).map((row) => row.scheduled_at.getTime());
      const last = times[times.length - 1];
      const wait = Math.max(
        last === undefined ? 0 : last + RESEND_COOLDOWN_MS - now.getTime(),
        times.length >= PER_INVITE ? times[0] + LIMIT_WINDOW_MS - now.getTime() : 0,
      );

      views.set(invite.id, { email_status: effectiveStatus(invite, now), resend_after_seconds: seconds(wait) });
    }

    return views;
  }

  // Starts attempts for just-committed emails without waiting for them.
  deliverSoon(inviteIds: number[]): void {
    if (this.stopped) {
      return;
    }

    for (const inviteId of inviteIds) {
      this.track(this.attempt(inviteId));
    }
  }

  // One pass over due work: queued emails whose time has come and attempts
  // whose lease ran out. Ended invitations leave the queue.
  async processDue(now = new Date()): Promise<number> {
    if (this.polling || this.stopped) {
      return 0;
    }

    this.polling = true;

    try {
      const invites = this.dataSource.getRepository(SpaceInvite);
      await invites.update(
        {
          email_status: In([SpaceInviteEmailStatus.QUEUED, SpaceInviteEmailStatus.SENDING]),
          email_next_attempt_at: LessThanOrEqual(now),
          expires_at: LessThanOrEqual(now),
        },
        { email_next_attempt_at: null },
      );
      const due = await invites.find({
        select: { id: true },
        where: {
          email_status: In([SpaceInviteEmailStatus.QUEUED, SpaceInviteEmailStatus.SENDING]),
          email_next_attempt_at: LessThanOrEqual(now),
          expires_at: MoreThan(now),
        },
        order: { email_next_attempt_at: 'ASC' },
        take: POLL_BATCH,
      });

      for (const { id } of due) {
        if (this.stopped) {
          break;
        }

        await this.attempt(id);
      }

      await this.dataSource.query('DELETE FROM space_invite_emails WHERE scheduled_at <= ? LIMIT ?', [
        new Date(now.getTime() - LIMIT_WINDOW_MS),
        PURGE_BATCH,
      ]);

      return due.length;
    } catch (error) {
      this.logger.warn(`Invitation email run failed: ${error instanceof Error ? error.message : String(error)}`);

      return 0;
    } finally {
      this.polling = false;
    }
  }

  async attempt(inviteId: number): Promise<AttemptOutcome> {
    try {
      const invite = await this.claim(inviteId, new Date());

      if (!invite) {
        return 'skipped';
      }

      if (invite.email_attempts > MAX_ATTEMPTS) {
        await this.finish(invite, SpaceInviteEmailStatus.FAILED);
        this.logger.warn(`Invitation ${invite.id} email gave up after ${MAX_ATTEMPTS} attempts without a result`);

        return 'failed';
      }

      return await this.send(invite);
    } catch (error) {
      this.logger.warn(
        `Invitation ${inviteId} email attempt could not run: ${error instanceof Error ? error.message : String(error)}`,
      );

      return 'skipped';
    }
  }

  private async send(invite: SpaceInvite): Promise<AttemptOutcome> {
    const space = await this.dataSource.getRepository(Space).findOne({ where: { id: invite.space_id } });

    if (!space) {
      return 'skipped';
    }

    try {
      await this.mailService.sendSpaceInvite({
        to: invite.email,
        spaceName: space.name,
        link: this.links.link(invite),
        code: invite.code,
        expiresAt: invite.expires_at,
      });
    } catch (error) {
      const failure = error instanceof MailDeliveryError ? error : new MailDeliveryError(false, 'unexpected error');
      const final = failure.permanent || invite.email_attempts >= MAX_ATTEMPTS;
      const recorded = final
        ? await this.finish(invite, SpaceInviteEmailStatus.FAILED)
        : await this.finish(invite, SpaceInviteEmailStatus.QUEUED, RETRY_DELAYS_MS[invite.email_attempts - 1]);
      this.logger.warn(
        `Invitation ${invite.id} email attempt ${invite.email_attempts} failed` +
          `${final ? '' : ', will retry'}${recorded ? '' : ' (superseded)'}: ${failure.reason}`,
      );

      return final ? 'failed' : 'retry';
    }

    const recorded = await this.finish(invite, SpaceInviteEmailStatus.SENT);
    this.logger.log(
      `Invitation ${invite.id} email accepted by SMTP on attempt ${invite.email_attempts}${recorded ? '' : ' (superseded)'}`,
    );

    return 'sent';
  }

  // Takes the row for one attempt if it is due and its invitation active.
  // Of competing workers only one update matches.
  private async claim(inviteId: number, now: Date): Promise<SpaceInvite | null> {
    const leaseEnd = new Date(now.getTime() + LEASE_MS);
    const { affected } = await this.dataSource
      .createQueryBuilder()
      .update(SpaceInvite)
      .set({
        email_status: SpaceInviteEmailStatus.SENDING,
        email_attempt_id: () => 'email_attempt_id + 1',
        email_attempts: () => 'email_attempts + 1',
        email_lease_expires_at: leaseEnd,
        email_next_attempt_at: leaseEnd,
      })
      .where('id = :inviteId', { inviteId })
      .andWhere('accepted_at IS NULL AND revoked_at IS NULL AND expires_at > :now AND token_nonce IS NOT NULL', {
        now,
      })
      .andWhere(
        new Brackets((due) =>
          due
            .where('email_status = :queued AND email_next_attempt_at <= :now', {
              queued: SpaceInviteEmailStatus.QUEUED,
              now,
            })
            .orWhere('email_status = :sending AND email_lease_expires_at <= :now', {
              sending: SpaceInviteEmailStatus.SENDING,
              now,
            }),
        ),
      )
      .execute();

    if (!affected) {
      return null;
    }

    const invite = await this.dataSource.getRepository(SpaceInvite).findOne({ where: { id: inviteId } });

    return invite && isActiveInvite(invite, now) ? invite : null;
  }

  // Writes the result only while the row is still this attempt's.
  private async finish(invite: SpaceInvite, status: SpaceInviteEmailStatus, retryInMs?: number): Promise<boolean> {
    const now = new Date();
    const { affected } = await this.dataSource.getRepository(SpaceInvite).update(
      { id: invite.id, email_attempt_id: invite.email_attempt_id, email_status: SpaceInviteEmailStatus.SENDING },
      {
        email_status: status,
        email_lease_expires_at: null,
        email_next_attempt_at: retryInMs === undefined ? null : new Date(now.getTime() + retryInMs),
        ...(status === SpaceInviteEmailStatus.SENT ? { email_last_sent_at: now } : {}),
      },
    );

    return Boolean(affected);
  }

  private track(work: Promise<unknown>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }
}

// `sending` whose lease ran out is waiting for its retry, so it reads as queued.
export function effectiveStatus(
  invite: Pick<SpaceInvite, 'email_status' | 'email_lease_expires_at'>,
  now = new Date(),
): SpaceInviteEmailStatus {
  const leaseRunning = invite.email_lease_expires_at !== null && invite.email_lease_expires_at > now;

  return invite.email_status === SpaceInviteEmailStatus.SENDING && !leaseRunning
    ? SpaceInviteEmailStatus.QUEUED
    : invite.email_status;
}
