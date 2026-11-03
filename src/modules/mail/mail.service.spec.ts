import { ServiceUnavailableException } from '@nestjs/common';

// @swc/jest wraps `import * as x from 'y'` per-file (see CLAUDE.md's
// @swc/jest gotcha) - jest.mock is the only form that actually replaces
// what MailService itself sees when it imports { createTransport }.
const sendMail = jest.fn();
const createTransport = jest.fn<{ sendMail: jest.Mock }, unknown[]>(() => ({ sendMail }));
jest.mock('nodemailer', () => ({ createTransport: (...args: unknown[]) => createTransport(...args) }));

import { MailDeliveryError, MailService, SMTP_TIMEOUTS_MS, toMailDeliveryError } from './mail.service';
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

  describe('sendPasswordResetCode', () => {
    beforeEach(() => {
      service = new MailService(buildConfigService(baseEnv));
    });

    it('sends the code with its remaining lifetime and says only the latest code works', async () => {
      sendMail.mockResolvedValue(undefined);

      await service.sendPasswordResetCode('user@example.com', '042917', new Date(Date.now() + 17 * 60000 - 1000));

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: baseEnv.MAIL_FROM,
          to: 'user@example.com',
          subject: 'Reset your Success Budget password',
        }),
      );
      const { text, html } = sendMail.mock.calls[0][0] as { text: string; html: string };
      for (const body of [text, html]) {
        expect(body).toContain('042917');
        expect(body).toContain('expires in 17 minutes');
        expect(body).toContain('Only the code from the most recent email works.');
      }
    });

    it('turns a delivery failure into a ServiceUnavailableException without logging the code', async () => {
      sendMail.mockRejectedValue(new Error('connection refused'));
      const logError = jest.spyOn(service['logger'], 'error').mockImplementation();

      await expect(
        service.sendPasswordResetCode('user@example.com', '042917', new Date(Date.now() + 60000)),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(logError).toHaveBeenCalledWith(
        'Failed to send password reset email to user@example.com: connection refused',
      );
    });
  });

  it('bounds every SMTP wait', () => {
    service = new MailService(buildConfigService(baseEnv));

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: SMTP_TIMEOUTS_MS.connection,
        greetingTimeout: SMTP_TIMEOUTS_MS.greeting,
        socketTimeout: SMTP_TIMEOUTS_MS.socket,
      }),
    );
  });

  describe('sendSpaceInvite', () => {
    const details = {
      to: 'anna@example.com',
      spaceName: 'Family <b>',
      link: 'https://app.example.com/invite#token=5.abc',
      code: '042917',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
    };

    it('sends the rendered invitation from the configured address', async () => {
      service = new MailService(buildConfigService(baseEnv));
      sendMail.mockResolvedValue(undefined);

      await service.sendSpaceInvite(details);

      expect(sendMail).toHaveBeenCalledWith({
        from: baseEnv.MAIL_FROM,
        to: 'anna@example.com',
        subject: 'You are invited to "Family <b>" in Success Budget',
        text: expect.stringContaining(details.link),
        html: expect.stringContaining('Family &lt;b&gt;'),
      });
    });

    it('turns an SMTP failure into a MailDeliveryError', async () => {
      service = new MailService(buildConfigService(baseEnv));
      sendMail.mockRejectedValue(Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }));

      await expect(service.sendSpaceInvite(details)).rejects.toEqual(
        new MailDeliveryError(false, 'ETIMEDOUT | Connection timeout'),
      );
    });
  });

  describe('toMailDeliveryError', () => {
    it('treats an SMTP 5xx reply as permanent and anything else as temporary', () => {
      expect(toMailDeliveryError(Object.assign(new Error('rejected'), { responseCode: 550 })).permanent).toBe(true);
      expect(toMailDeliveryError(Object.assign(new Error('busy'), { responseCode: 421 })).permanent).toBe(false);
      expect(toMailDeliveryError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).permanent).toBe(false);
      expect(toMailDeliveryError('boom').permanent).toBe(false);
    });

    it('keeps addresses, links and codes out of the reason', () => {
      const error = Object.assign(
        new Error(
          'Message failed: 550 5.1.1 <anna@example.com>: unknown user; ' +
            'body had https://app.example.com/invite#token=5.secretproof and code 042917',
        ),
        { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' },
      );

      const { reason } = toMailDeliveryError(error);

      expect(reason).toContain('EENVELOPE | smtp 550 | RCPT TO');
      expect(reason).not.toContain('anna@example.com');
      expect(reason).not.toContain('secretproof');
      expect(reason).not.toContain('042917');
      expect(reason.length).toBeLessThanOrEqual(260);
    });
  });
});
