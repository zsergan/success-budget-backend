import { createHash, createHmac } from 'node:crypto';

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

export interface ResetTokenSource {
  challengeId: string;
  userId: number;
  codeHash: string;
  verifiedAt: Date;
}

// Derived, not random: repeating the accepted code after a lost response
// yields the same token instead of a second one. Only its hash is stored.
export function deriveResetToken(key: Buffer, source: ResetTokenSource): string {
  return createHmac('sha256', key)
    .update(`reset-token:${source.challengeId}:${source.userId}:${source.codeHash}:${source.verifiedAt.getTime()}`)
    .digest('base64url');
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
