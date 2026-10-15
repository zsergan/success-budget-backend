import { createHash, createHmac, randomBytes } from 'node:crypto';

const RESET_TOKEN_BYTES = 32;

// Addresses and six-digit codes are guessable, so their hashes are keyed:
// without the server secret a copy of the table cannot be brute-forced.
export function passwordResetKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('password-reset').digest();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashEmail(key: Buffer, email: string): string {
  return createHmac('sha256', key)
    .update(`email:${normalizeEmail(email)}`)
    .digest('hex');
}

export function hashCode(key: Buffer, emailHash: string, code: string): string {
  return createHmac('sha256', key).update(`code:${emailHash}:${code}`).digest('hex');
}

export function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
