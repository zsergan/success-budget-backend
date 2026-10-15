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
  const valid = { reset_token: 'mX3v0b2rQ1kJ8yT6pZ4wN7cL5aH9eF0dS2gU1iO3qRk', password: 'secret1' };

  it('accepts a token and a password', async () => {
    expect(await errorsOf(CompletePasswordResetDto, valid)).toEqual({});
  });

  it('refuses a password shorter than six characters', async () => {
    expect(Object.keys(await errorsOf(CompletePasswordResetDto, { ...valid, password: '12345' }))).toEqual([
      'password',
    ]);
  });

  it.each(['', 'x'.repeat(256), 7])('refuses the reset_token %p', async (reset_token) => {
    expect(Object.keys(await errorsOf(CompletePasswordResetDto, { ...valid, reset_token }))).toEqual(['reset_token']);
  });
});
