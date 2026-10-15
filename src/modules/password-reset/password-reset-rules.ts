import type { PasswordResetChallenge } from '@entities/password-reset-challenge.entity';
import {
  PASSWORD_RESET_MAX_CODE_ATTEMPTS,
  PASSWORD_RESET_RESEND_COOLDOWN_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
  PASSWORD_RESET_WINDOW_MAX_FAILED_ATTEMPTS,
  PASSWORD_RESET_WINDOW_MAX_REQUESTS,
  PASSWORD_RESET_WINDOW_MS,
} from './password-reset.constants';

// pending: takes codes; verified: replays its authorization for the
// accepted code; ended: a request starts a new challenge
export type ChallengeState = 'pending' | 'verified' | 'ended';

type StateFields = Pick<
  PasswordResetChallenge,
  'attempts' | 'expires_at' | 'verified_at' | 'reset_token_expires_at' | 'completed_at'
>;

type WindowFields = Pick<PasswordResetChallenge, 'window_started_at' | 'window_requests' | 'window_failed_attempts'>;

export function challengeState(challenge: StateFields, now: Date): ChallengeState {
  if (challenge.completed_at || challenge.attempts >= PASSWORD_RESET_MAX_CODE_ATTEMPTS) {
    return 'ended';
  }

  if (challenge.verified_at) {
    return challenge.reset_token_expires_at && challenge.reset_token_expires_at > now ? 'verified' : 'ended';
  }

  return challenge.expires_at > now ? 'pending' : 'ended';
}

// a window that has ended counts nothing; the next counted event starts one
export function currentWindow(challenge: WindowFields, now: Date): WindowFields {
  if (now.getTime() >= challenge.window_started_at.getTime() + PASSWORD_RESET_WINDOW_MS) {
    return { window_started_at: now, window_requests: 0, window_failed_attempts: 0 };
  }

  return {
    window_started_at: challenge.window_started_at,
    window_requests: challenge.window_requests,
    window_failed_attempts: challenge.window_failed_attempts,
  };
}

export function secondsUntil(time: Date | number, now: Date): number {
  return Math.max(1, Math.ceil((new Date(time).getTime() - now.getTime()) / 1000));
}

// Retry-After for a refused request, or null; the longest wait applies so
// the client is refused once, not once per limit.
export function requestRetryAfter(
  challenge: WindowFields & Pick<PasswordResetChallenge, 'last_requested_at'>,
  now: Date,
): number | null {
  const waits: number[] = [];
  const cooldownEnd = challenge.last_requested_at.getTime() + PASSWORD_RESET_RESEND_COOLDOWN_MS;

  if (now.getTime() < cooldownEnd) {
    waits.push(secondsUntil(cooldownEnd, now));
  }

  const window = currentWindow(challenge, now);

  if (window.window_requests >= PASSWORD_RESET_WINDOW_MAX_REQUESTS) {
    waits.push(secondsUntil(window.window_started_at.getTime() + PASSWORD_RESET_WINDOW_MS, now));
  }

  return waits.length ? Math.max(...waits) : null;
}

export function verifyRetryAfter(challenge: WindowFields, now: Date): number | null {
  const window = currentWindow(challenge, now);

  if (window.window_failed_attempts >= PASSWORD_RESET_WINDOW_MAX_FAILED_ATTEMPTS) {
    return secondsUntil(window.window_started_at.getTime() + PASSWORD_RESET_WINDOW_MS, now);
  }

  return null;
}

export function resetTokenExpiry(now: Date, challengeExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS, challengeExpiresAt.getTime()));
}

// the authorization behind tokenHash can still complete the reset
export function canComplete(
  challenge: StateFields & Pick<PasswordResetChallenge, 'user_id' | 'reset_token_hash'>,
  tokenHash: string,
  now: Date,
): boolean {
  return (
    challenge.user_id !== null &&
    challenge.reset_token_hash === tokenHash &&
    challengeState(challenge, now) === 'verified'
  );
}
