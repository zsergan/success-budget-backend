import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { User } from '@entities/user.entity';
import { ConfirmationType, ConfirmationCodeSendStatus } from '@shared/enums';
import { ErrorMessages } from '@shared/error-messages';
import { RetryAfterException } from '@shared/retry-after.exception';
import { CONFIRMATION_CODE_RESEND_COOLDOWN_MS, CONFIRMATION_CODE_TTL_MS } from '@shared/constants';
import { assertFound, generateRandomNumberString } from '@shared/utils';

export interface ReservedConfirmationCode {
  id: number;
  code: string;
  expiresAt: Date;
  // false means a valid code was already confirmed delivered recently
  // enough (see CONFIRMATION_CODE_RESEND_COOLDOWN_MS) - the caller should
  // not attempt to send another email for it.
  shouldSend: boolean;
  // Identifies *this* reservation - pass it back to markSent()/markFailed()
  // unchanged so they only apply if it's still the current attempt (see
  // send_attempt_id on the entity).
  attemptId: number;
}

type ExistingCodeSendState = Pick<ConfirmationCode, 'send_status' | 'last_attempted_at'>;

type ResendDecision = { action: 'send' } | { action: 'skip' } | { action: 'deny'; retryAfterSeconds: number };

// Pure so it can be unit-tested without touching TypeORM. Only decides for an
// active (non-expired) code - with none, a new one is always created.
export function decideSendAction(existing: ExistingCodeSendState, now: number, cooldownMs: number): ResendDecision {
  const elapsed = existing.last_attempted_at ? now - existing.last_attempted_at.getTime() : Infinity;

  if (elapsed >= cooldownMs) {
    return { action: 'send' };
  }

  // A confirmed-successful send within the cooldown is a quiet no-op (the
  // client already got the email). A pending or failed attempt within the
  // cooldown is not - the caller needs to know nothing was actually sent.
  if (existing.send_status === ConfirmationCodeSendStatus.SENT) {
    return { action: 'skip' };
  }

  return { action: 'deny', retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000) };
}

@Injectable()
export class ConfirmationCodesService {
  constructor(
    @InjectRepository(ConfirmationCode)
    private readonly confirmationCodeRepository: Repository<ConfirmationCode>,
    private readonly dataSource: DataSource,
  ) {}

  // The caller must already hold the user's row lock (see reserveSend) -
  // user first, then code, so lock order is the same everywhere.
  async lockActive(
    userId: number,
    confirmationType: ConfirmationType,
    manager: EntityManager,
  ): Promise<ConfirmationCode | null> {
    return manager
      .createQueryBuilder(ConfirmationCode, 'confirmation_code')
      .setLock('pessimistic_write')
      .where({ user_id: userId, confirmation_type: confirmationType })
      .andWhere('confirmation_code.expired_at >= :now', { now: new Date() })
      .getOne();
  }

  // Atomically decides whether a send attempt is allowed and, if so,
  // reserves it (writes last_attempted_at/send_status='pending' *before*
  // returning) - the caller then does the actual SMTP call outside of any
  // transaction and reports the outcome via markSent()/markFailed().
  //
  // Two concurrent calls for the same user are serialized by locking the
  // user's row for the duration of this (short, network-call-free)
  // transaction: the user row always exists by the time this runs (it's
  // created earlier in the same request), so it doubles as a cheap mutex
  // without needing a dedicated lock table or a unique index that would
  // have to account for confirmation_codes' historical rows.
  async reserveSend(userId: number, confirmationType: ConfirmationType): Promise<ReservedConfirmationCode> {
    return this.dataSource.transaction(async (manager) => {
      const user = await manager
        .createQueryBuilder(User, 'user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      assertFound(user);

      // same answer registration gives for a verified account - a
      // verification may have committed since the caller's own check
      if (confirmationType === ConfirmationType.EMAIL && user.email_verified) {
        throw new HttpException(ErrorMessages.EMAIL_ALREADY_EXISTS, HttpStatus.BAD_REQUEST);
      }

      const existing = await this.lockActive(userId, confirmationType, manager);

      const now = new Date();
      const repository = manager.getRepository(ConfirmationCode);

      if (!existing) {
        const created = await repository.save(
          repository.create({
            user_id: userId,
            confirmation_type: confirmationType,
            confirmation_code: generateRandomNumberString(),
            created_at: now,
            expired_at: new Date(now.getTime() + CONFIRMATION_CODE_TTL_MS),
            last_attempted_at: now,
            send_status: ConfirmationCodeSendStatus.PENDING,
            send_attempt_id: 1,
          }),
        );

        return {
          id: created.id,
          code: created.confirmation_code,
          expiresAt: created.expired_at,
          shouldSend: true,
          attemptId: created.send_attempt_id,
        };
      }

      const decision = decideSendAction(existing, now.getTime(), CONFIRMATION_CODE_RESEND_COOLDOWN_MS);

      if (decision.action === 'deny') {
        throw new RetryAfterException(ErrorMessages.CONFIRMATION_EMAIL_RATE_LIMITED, decision.retryAfterSeconds);
      }

      if (decision.action === 'skip') {
        return {
          id: existing.id,
          code: existing.confirmation_code,
          expiresAt: existing.expired_at,
          shouldSend: false,
          attemptId: existing.send_attempt_id,
        };
      }

      // decision.action === 'send': reuse the existing code (an active code
      // keeps the same 10-minute expiry across resends), just reserve a
      // fresh, uniquely-identified attempt for it.
      const attemptId = existing.send_attempt_id + 1;
      await repository.update(existing.id, {
        last_attempted_at: now,
        send_status: ConfirmationCodeSendStatus.PENDING,
        send_attempt_id: attemptId,
      });

      return {
        id: existing.id,
        code: existing.confirmation_code,
        expiresAt: existing.expired_at,
        shouldSend: true,
        attemptId,
      };
    });
  }

  // Only takes effect if attemptId is still the code's current send attempt
  // - a stale attempt that finishes after a newer one has already been
  // reserved (or settled) is a silent no-op instead of overwriting a status
  // it no longer has authority over.
  async markSent(id: number, attemptId: number): Promise<void> {
    await this.confirmationCodeRepository.update(
      { id, send_attempt_id: attemptId },
      { send_status: ConfirmationCodeSendStatus.SENT, last_sent_at: new Date() },
    );
  }

  async markFailed(id: number, attemptId: number): Promise<void> {
    await this.confirmationCodeRepository.update(
      { id, send_attempt_id: attemptId },
      { send_status: ConfirmationCodeSendStatus.FAILED },
    );
  }

  async incrementAttempts(id: number, manager: EntityManager): Promise<void> {
    await manager.getRepository(ConfirmationCode).increment({ id }, 'attempts', 1);
  }

  // A second in the past, not now: expired_at is a second-precision
  // timestamp and MySQL rounds fractional seconds, so "now" can be stored up
  // to half a second ahead and keep the code active until then.
  async expire(id: number, manager: EntityManager): Promise<void> {
    await manager.getRepository(ConfirmationCode).update(id, { expired_at: new Date(Date.now() - 1000) });
  }
}
