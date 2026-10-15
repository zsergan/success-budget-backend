import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CompletePasswordResetDto,
  RequestPasswordResetDto,
  VerifyPasswordResetDto,
} from './password-reset-requests.dto';

const errorsOf = async <T extends object>(type: new () => T, plain: object) => {
  const errors = await validate(plainToInstance(type, plain), { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.values(error.constraints ?? {})]));
};

describe('RequestPasswordResetDto', () => {
  it('accepts an email', async () => {
    expect(await errorsOf(RequestPasswordResetDto, { email: 'user@example.com' })).toEqual({});
  });

  it.each([{}, { email: '' }, { email: 'not-an-email' }, { email: 42 }])('refuses %p', async (plain) => {
    expect(Object.keys(await errorsOf(RequestPasswordResetDto, plain))).toEqual(['email']);
  });
});

describe('VerifyPasswordResetDto', () => {
  const valid = { email: 'user@example.com', code: '042917' };

  it('accepts six digits with a leading zero', async () => {
    expect(await errorsOf(VerifyPasswordResetDto, valid)).toEqual({});
  });

  it.each(['42917', '0429170', '04291a', ' 042917', '٠٤٢٩١٧', 42917])('refuses the code %p', async (code) => {
    expect(Object.keys(await errorsOf(VerifyPasswordResetDto, { ...valid, code }))).toEqual(['code']);
  });
});

describe('CompletePasswordResetDto', () => {
  const valid = { reset_token: 'mX3v0b2rQ1kJ8yT6pZ4wN7cL5aH9eF0dS2gU1iO3qRk', password: 'secret12' };

  it('accepts a token and a password', async () => {
    expect(await errorsOf(CompletePasswordResetDto, valid)).toEqual({});
  });

  it.each(['a1234567', 'пароль1z', 'x1' + 'a'.repeat(70), 'ж1' + 'a'.repeat(69)])(
    'accepts the password %p',
    async (password) => {
      expect(await errorsOf(CompletePasswordResetDto, { ...valid, password })).toEqual({});
    },
  );

  it.each([
    ['shorter than eight characters', 'secret1'],
    ['without a letter', '12345678'],
    ['with only non-Latin letters', 'пароль12'],
    ['without a digit', 'password'],
    ['with a non-ASCII digit only', 'password٣'],
    ['longer than 72 bytes', 'x1' + 'a'.repeat(71)],
    ['over 72 bytes in 72 characters', 'ж1' + 'a'.repeat(70)],
    ['missing', undefined],
    ['not a string', 12345678],
  ])('refuses a password %s', async (_case, password) => {
    expect(Object.keys(await errorsOf(CompletePasswordResetDto, { ...valid, password }))).toEqual(['password']);
  });

  it.each(['', 'x'.repeat(256), 7])('refuses the reset_token %p', async (reset_token) => {
    expect(Object.keys(await errorsOf(CompletePasswordResetDto, { ...valid, reset_token }))).toEqual(['reset_token']);
  });
});
