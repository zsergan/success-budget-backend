import { type BeforeApplicationShutdown, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';

import { PasswordResetChallenge } from '@entities/password-reset-challenge.entity';
import { User } from '@entities/user.entity';
import { MailService } from '@modules/mail/mail.service';
import { ApiException } from '@shared/api.exception';
import { ConfirmationCodeSendStatus } from '@shared/enums';
import { RetryAfterException } from '@shared/retry-after.exception';
import { constantTimeEquals, generateRandomNumberString, isDuplicateKey, runWriteTransaction } from '@shared/utils';
import type { EnvironmentVariables } from '@config/env.validation';
import type { RequestPasswordResetDto, VerifyPasswordResetDto } from './dto/password-reset-requests.dto';
import type { PasswordResetAuthorization, PasswordResetRequested } from './dto/password-reset-responses';
import {
  PASSWORD_RESET_CODE_TTL_MS,
  PASSWORD_RESET_MAX_CODE_ATTEMPTS,
  PASSWORD_RESET_RESEND_COOLDOWN_MS,
} from './password-reset.constants';
import {
  challengeState,
  currentWindow,
  requestRetryAfter,
  resetTokenExpiry,
  secondsUntil,
  verifyRetryAfter,
} from './password-reset-rules';
import { deriveResetToken, hashCode, hashEmail, hashResetToken, passwordResetKey } from './password-reset-secrets';

const EMAIL_HASH_INDEX = 'UQ_password_reset_challenges_email_hash';

export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'If this email belongs to a verified account, a password reset code has been sent';

interface Delivery {
  challengeId: string;
  attemptId: number;
  to: string;
  code: string;
  expiresAt: Date;
}

type VerifyOutcome = { authorization: PasswordResetAuthorization } | { rejection: HttpException };

@Injectable()
export class PasswordResetService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly key: Buffer;
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    @InjectRepository(PasswordResetChallenge)
    private readonly challengeRepository: Repository<PasswordResetChallenge>,
    private readonly dataSource: DataSource,
    private readonly mailService: MailService,
    configService: ConfigService<EnvironmentVariables, true>,
  ) {
    this.key = passwordResetKey(configService.getOrThrow('JWT_SECRET', { infer: true }));
  }

  // The answer never depends on the account: the email goes out after the
  // response, and a delivery failure is only recorded.
  async request(dto: RequestPasswordResetDto): Promise<PasswordResetRequested> {
    const delivery = await this.reserve(dto.email);

    if (delivery) {
      const sending = this.deliver(delivery).finally(() => this.deliveries.delete(sending));
      this.deliveries.add(sending);
    }

    return {
      message: PASSWORD_RESET_REQUESTED_MESSAGE,
      resend_after_seconds: PASSWORD_RESET_RESEND_COOLDOWN_MS / 1000,
    };
  }

  async verify(dto: VerifyPasswordResetDto): Promise<PasswordResetAuthorization> {
    const emailHash = hashEmail(this.key, dto.email);

    // A rejection is returned rather than thrown so the transaction commits
    // the counted attempt before the error reaches the client.
    const outcome = await runWriteTransaction(this.dataSource, (manager) =>
      this.verifyIn(manager, emailHash, dto.code),
    );

    if ('rejection' in outcome) {
      throw outcome.rejection;
    }

    return outcome.authorization;
  }

  async settleDeliveries(): Promise<void> {
    await Promise.all([...this.deliveries]);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.settleDeliveries();
  }

  private async reserve(email: string): Promise<Delivery | null> {
    const emailHash = hashEmail(this.key, email);

    for (let attempt = 1; ; attempt++) {
      try {
        return await runWriteTransaction(this.dataSource, (manager) => this.reserveIn(manager, email, emailHash));
      } catch (error) {
        // a concurrent first request for the address inserted the row; the retry waits on its lock
        if (attempt >= 2 || !isDuplicateKey(error, EMAIL_HASH_INDEX)) {
          throw error;
        }
      }
    }
  }

  private async reserveIn(manager: EntityManager, email: string, emailHash: string): Promise<Delivery | null> {
    const now = new Date();
    const user = await manager
      .createQueryBuilder(User, 'user')
      .setLock('pessimistic_read')
      .where('user.email = :email', { email })
      .getOne();
    const account = user?.email_verified ? user : null;
    const challenge = await this.lockChallenge(manager, emailHash);

    if (challenge) {
      const retryAfter = requestRetryAfter(challenge, now);

      if (retryAfter !== null) {
        throw new RetryAfterException('PASSWORD_RESET_RATE_LIMITED', retryAfter);
      }
    }

    const code = generateRandomNumberString();
    const window = challenge
      ? currentWindow(challenge, now)
      : { window_started_at: now, window_requests: 0, window_failed_attempts: 0 };
    const rotates = challenge !== null && challengeState(challenge, now) === 'pending';
    const expiresAt = rotates ? challenge.expires_at : new Date(now.getTime() + PASSWORD_RESET_CODE_TTL_MS);
    const attemptId = (challenge?.send_attempt_id ?? 0) + 1;
    const fields: Partial<PasswordResetChallenge> = {
      user_id: account?.id ?? null,
      code_hash: account ? hashCode(this.key, emailHash, code) : null,
      last_requested_at: now,
      window_started_at: window.window_started_at,
      window_requests: window.window_requests + 1,
      window_failed_attempts: window.window_failed_attempts,
      send_attempt_id: attemptId,
      send_status: account ? ConfirmationCodeSendStatus.PENDING : null,
    };

    if (!rotates) {
      Object.assign(fields, {
        attempts: 0,
        started_at: now,
        expires_at: expiresAt,
        verified_at: null,
        reset_token_hash: null,
        reset_token_expires_at: null,
        completed_at: null,
      });
    }

    const repository = manager.getRepository(PasswordResetChallenge);
    let challengeId: string;

    if (challenge) {
      await repository.update(challenge.id, fields);
      challengeId = challenge.id;
    } else {
      const inserted = await repository.insert({ ...fields, email_hash: emailHash });
      challengeId = String(inserted.identifiers[0].id);
    }

    return account ? { challengeId, attemptId, to: account.email, code, expiresAt } : null;
  }

  private async verifyIn(manager: EntityManager, emailHash: string, code: string): Promise<VerifyOutcome> {
    const now = new Date();
    const challenge = await this.lockChallenge(manager, emailHash);

    if (!challenge) {
      return { rejection: new ApiException('PASSWORD_RESET_CODE_UNUSABLE', HttpStatus.BAD_REQUEST) };
    }

    const retryAfter = verifyRetryAfter(challenge, now);

    if (retryAfter !== null) {
      return { rejection: new RetryAfterException('PASSWORD_RESET_RATE_LIMITED', retryAfter) };
    }

    const state = challengeState(challenge, now);

    if (state === 'ended') {
      return { rejection: new ApiException('PASSWORD_RESET_CODE_UNUSABLE', HttpStatus.BAD_REQUEST) };
    }

    const repository = manager.getRepository(PasswordResetChallenge);
    const codeHash = challenge.code_hash;

    if (codeHash === null || !constantTimeEquals(hashCode(this.key, emailHash, code), codeHash)) {
      const attempts = challenge.attempts + 1;
      const window = currentWindow(challenge, now);
      const exhausted = attempts >= PASSWORD_RESET_MAX_CODE_ATTEMPTS;

      await repository.update(challenge.id, {
        attempts,
        window_started_at: window.window_started_at,
        window_failed_attempts: window.window_failed_attempts + 1,
        ...(exhausted ? { reset_token_hash: null, reset_token_expires_at: null } : {}),
      });

      return {
        rejection: new ApiException(
          exhausted ? 'PASSWORD_RESET_CODE_UNUSABLE' : 'PASSWORD_RESET_CODE_INVALID',
          HttpStatus.BAD_REQUEST,
        ),
      };
    }

    // a code_hash exists only for a challenge bound to an account
    const userId = challenge.user_id!;

    if (state === 'verified') {
      const token = deriveResetToken(this.key, {
        challengeId: challenge.id,
        userId,
        codeHash,
        verifiedAt: challenge.verified_at!,
      });

      return { authorization: authorization(token, challenge.reset_token_expires_at!, now) };
    }

    const tokenExpiresAt = resetTokenExpiry(now, challenge.expires_at);
    const token = deriveResetToken(this.key, { challengeId: challenge.id, userId, codeHash, verifiedAt: now });

    await repository.update(challenge.id, {
      verified_at: now,
      reset_token_hash: hashResetToken(token),
      reset_token_expires_at: tokenExpiresAt,
    });

    return { authorization: authorization(token, tokenExpiresAt, now) };
  }

  private async lockChallenge(manager: EntityManager, emailHash: string): Promise<PasswordResetChallenge | null> {
    return manager
      .createQueryBuilder(PasswordResetChallenge, 'challenge')
      .setLock('pessimistic_write')
      .where('challenge.email_hash = :emailHash', { emailHash })
      .getOne();
  }

  private async deliver(delivery: Delivery): Promise<void> {
    let status = ConfirmationCodeSendStatus.SENT;

    try {
      await this.mailService.sendPasswordResetCode(delivery.to, delivery.code, delivery.expiresAt);
    } catch {
      // MailService has logged it; the client is told nothing either way
      status = ConfirmationCodeSendStatus.FAILED;
    }

    try {
      // a stale attempt, overtaken by a newer request, changes nothing
      await this.challengeRepository.update(
        { id: delivery.challengeId, send_attempt_id: delivery.attemptId },
        status === ConfirmationCodeSendStatus.SENT
          ? { send_status: status, last_sent_at: new Date() }
          : { send_status: status },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record a password reset email outcome: ${reason}`);
    }
  }
}

function authorization(token: string, expiresAt: Date, now: Date): PasswordResetAuthorization {
  return { reset_token: token, expires_in_seconds: secondsUntil(expiresAt, now) };
}
