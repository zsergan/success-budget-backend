import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';

// @swc/jest wraps `import * as x from 'y'` per-file (see CLAUDE.md's
// @swc/jest gotcha) - jest.mock is the only form that actually replaces
// what MailService itself sees when it imports { createTransport }.
const sendMail = jest.fn();
const createTransport = jest.fn(() => ({ sendMail }));
jest.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => createTransport(...args) }));

import { MailService } from './mail.service';

describe('MailService', () => {
  let service: MailService;

  const buildConfigService = (values: Record<string, string>) =>
    ({
      getOrThrow: jest.fn((key: string) => values[key]),
      get: jest.fn((key: string) => values[key]),
    }) as unknown as ConfigService;

  const baseEnv = {
    MAIL_FROM: 'Success Budget <no-reply@success-budget.local>',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds a transporter without auth when no SMTP credentials are configured', () => {
    service = new MailService(buildConfigService(baseEnv));

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', port: '1025', secure: false, auth: undefined }),
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

    await service.sendConfirmationCode('user@example.com', '123456');

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: baseEnv.MAIL_FROM,
        to: 'user@example.com',
        text: expect.stringContaining('123456'),
        html: expect.stringContaining('123456'),
      }),
    );
  });

  it('turns a delivery failure into a controlled ServiceUnavailableException', async () => {
    service = new MailService(buildConfigService(baseEnv));
    sendMail.mockRejectedValue(new Error('connection refused'));

    await expect(service.sendConfirmationCode('user@example.com', '123456')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
