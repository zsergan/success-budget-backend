import {
  challengeState,
  currentWindow,
  requestRetryAfter,
  resetTokenExpiry,
  secondsUntil,
  verifyRetryAfter,
} from './password-reset-rules';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MINUTE = 60_000;

describe('challengeState', () => {
  const pending = {
    attempts: 0,
    expires_at: at(10 * MINUTE),
    verified_at: null,
    reset_token_expires_at: null,
    completed_at: null,
  };

  it('is pending before expiry with attempts left', () => {
    expect(challengeState(pending, NOW)).toBe('pending');
    expect(challengeState({ ...pending, attempts: 4 }, NOW)).toBe('pending');
  });

  it.each([
    ['expired', { expires_at: NOW }],
    ['used up', { attempts: 5 }],
    ['completed', { completed_at: at(-MINUTE), verified_at: at(-2 * MINUTE), reset_token_expires_at: at(MINUTE) }],
    ['verified with an expired token', { verified_at: at(-MINUTE), reset_token_expires_at: NOW }],
    ['verified and then used up', { verified_at: at(-MINUTE), reset_token_expires_at: at(MINUTE), attempts: 5 }],
  ])('has ended when %s', (_case, fields) => {
    expect(challengeState({ ...pending, ...fields }, NOW)).toBe('ended');
  });

  it('is verified while its token is valid', () => {
    expect(challengeState({ ...pending, verified_at: at(-MINUTE), reset_token_expires_at: at(1) }, NOW)).toBe(
      'verified',
    );
  });
});

describe('limits', () => {
  const window = { window_started_at: at(-30 * MINUTE), window_requests: 2, window_failed_attempts: 3 };

  it('keeps the counters of a running window and drops an ended one', () => {
    expect(currentWindow(window, NOW)).toEqual(window);
    expect(currentWindow({ ...window, window_started_at: at(-60 * MINUTE) }, NOW)).toEqual({
      window_started_at: NOW,
      window_requests: 0,
      window_failed_attempts: 0,
    });
  });

  it('allows a request after the cooldown below the hourly limit', () => {
    expect(requestRetryAfter({ ...window, last_requested_at: at(-MINUTE) }, NOW)).toBeNull();
  });

  it('refuses a request within the cooldown for the rest of it, rounded up', () => {
    expect(requestRetryAfter({ ...window, last_requested_at: at(-20_500) }, NOW)).toBe(40);
  });

  it('refuses a request over the hourly limit until the window ends', () => {
    expect(requestRetryAfter({ ...window, window_requests: 5, last_requested_at: at(-2 * MINUTE) }, NOW)).toBe(1800);
  });

  it('gives the longest wait when both limits apply', () => {
    expect(requestRetryAfter({ ...window, window_requests: 5, last_requested_at: at(-1000) }, NOW)).toBe(1800);
  });

  it('allows a new window once the previous one ended', () => {
    const ended = { ...window, window_started_at: at(-61 * MINUTE), window_requests: 5, window_failed_attempts: 10 };

    expect(requestRetryAfter({ ...ended, last_requested_at: at(-2 * MINUTE) }, NOW)).toBeNull();
    expect(verifyRetryAfter(ended, NOW)).toBeNull();
  });

  it('refuses verification after 10 wrong codes in the window', () => {
    expect(verifyRetryAfter({ ...window, window_failed_attempts: 9 }, NOW)).toBeNull();
    expect(verifyRetryAfter({ ...window, window_failed_attempts: 10 }, NOW)).toBe(1800);
  });

  it('never answers less than one second', () => {
    expect(secondsUntil(at(10), NOW)).toBe(1);
    expect(secondsUntil(at(-10), NOW)).toBe(1);
  });
});

describe('resetTokenExpiry', () => {
  it('lasts 10 minutes but never past the challenge', () => {
    expect(resetTokenExpiry(NOW, at(30 * MINUTE))).toEqual(at(10 * MINUTE));
    expect(resetTokenExpiry(NOW, at(4 * MINUTE))).toEqual(at(4 * MINUTE));
  });
});
