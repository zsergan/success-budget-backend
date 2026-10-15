import {
  generateResetToken,
  hashCode,
  hashEmail,
  hashResetToken,
  normalizeEmail,
  passwordResetKey,
} from './password-reset-secrets';

describe('password reset secrets', () => {
  const key = passwordResetKey('a-test-jwt-secret-value');

  it('derives a key that depends on the secret', () => {
    expect(passwordResetKey('a-test-jwt-secret-value').equals(key)).toBe(true);
    expect(passwordResetKey('another-jwt-secret-value').equals(key)).toBe(false);
  });

  it('hashes an address case-insensitively, without the plain address', () => {
    const hash = hashEmail(key, 'User@Example.com');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmail(key, ' user@example.COM ')).toBe(hash);
    expect(hashEmail(key, 'other@example.com')).not.toBe(hash);
    expect(hashEmail(passwordResetKey('another-jwt-secret-value'), 'user@example.com')).not.toBe(hash);
    expect(normalizeEmail(' User@Example.com ')).toBe('user@example.com');
  });

  it('binds a code hash to its address', () => {
    const emailHash = hashEmail(key, 'user@example.com');
    const hash = hashCode(key, emailHash, '042917');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(key, emailHash, '042917')).toBe(hash);
    expect(hashCode(key, emailHash, '42917')).not.toBe(hash);
    expect(hashCode(key, hashEmail(key, 'other@example.com'), '042917')).not.toBe(hash);
  });

  it('generates unguessable URL-safe reset tokens and stores only their hash', () => {
    const token = generateResetToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateResetToken()).not.toBe(token);
    expect(hashResetToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });
});
