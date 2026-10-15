export const PASSWORD_RESET_CODE_TTL_MS = 1000 * 60 * 30; // 30 minutes

export const PASSWORD_RESET_RESEND_COOLDOWN_MS = 1000 * 60; // 1 minute

export const PASSWORD_RESET_MAX_CODE_ATTEMPTS = 5;

// capped by the challenge expiry
export const PASSWORD_RESET_TOKEN_TTL_MS = 1000 * 60 * 10; // 10 minutes

// per email address, across challenges
export const PASSWORD_RESET_WINDOW_MS = 1000 * 60 * 60; // 1 hour
export const PASSWORD_RESET_WINDOW_MAX_REQUESTS = 5;
export const PASSWORD_RESET_WINDOW_MAX_FAILED_ATTEMPTS = 10;
