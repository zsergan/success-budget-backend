import { ServiceUnavailableException } from '@nestjs/common';

// @swc/jest wraps `import * as x from 'y'` per-file (see CLAUDE.md's
// @swc/jest gotcha) - jest.mock is the only form that actually replaces
// what MailService itself sees when it imports { createTransport }.
const sendMail = jest.fn();
const createTransport = jest.fn<{ sendMail: jest.Mock }, unknown[]>(() => ({ sendMail }));
jest.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => createTransport(...args) }));

import { MailService } from './mail.service';
import { buildConfigService } from '@testing';

describe('MailService', () => {
  let service: MailService;

  const baseEnv = {
    MAIL_FROM: 'Success Budget <no-reply@success-budget.local>',
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds a transporter without auth when no SMTP credentials are configured', () => {
    service = new MailService(buildConfigService(baseEnv));

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', port: 1025, secure: false, auth: undefined }),
    );
  });

  it('builds a transporter with auth when SMTP credentials are configured', () => {
    service = new MailService(
      buildConfigService({ ...baseEnv, SMTP_SECURE: 'true', SMTP_USER: 'user', SMTP_PASSWORD: 'pass' }),
    );

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, auth: { user: 'user', pass: 'pass' } }),
    );
  });

  it('sends a confirmation code email from the configured address', async () => {
    service = new MailService(buildConfigService(baseEnv));
    sendMail.mockResolvedValue(undefined);

    await service.sendConfirmationCode('user@example.com', '123456', new Date(Date.now() + 10 * 60000));

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: baseEnv.MAIL_FROM,
        to: 'user@example.com',
        text: expect.stringContaining('123456'),
        html: expect.stringContaining('123456'),
      }),
    );
  });

  it('states the actual remaining time, not a fixed 10 minutes, for a resent code', async () => {
    service = new MailService(buildConfigService(baseEnv));
    sendMail.mockResolvedValue(undefined);

    await service.sendConfirmationCode('user@example.com', '123456', new Date(Date.now() + 3 * 60000));

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('3 minutes'),
        html: expect.stringContaining('3 minutes'),
      }),
    );
  });

  it('floors the stated expiry at 1 minute instead of showing a stale or negative value', async () => {
    service = new MailService(buildConfigService(baseEnv));
    sendMail.mockResolvedValue(undefined);

    await service.sendConfirmationCode('user@example.com', '123456', new Date(Date.now() - 5000));

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('1 minute.') }));
  });

  it('turns a delivery failure into a controlled ServiceUnavailableException', async () => {
    service = new MailService(buildConfigService(baseEnv));
    sendMail.mockRejectedValue(new Error('connection refused'));

    await expect(
      service.sendConfirmationCode('user@example.com', '123456', new Date(Date.now() + 60000)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
