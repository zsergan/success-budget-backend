import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { EnvironmentVariables } from '@config/env.validation';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    this.from = configService.getOrThrow('MAIL_FROM', { infer: true });
    this.transporter = createTransport({
      host: configService.getOrThrow('SMTP_HOST', { infer: true }),
      port: configService.getOrThrow('SMTP_PORT', { infer: true }),
      secure: configService.get('SMTP_SECURE', { infer: true }) === 'true',
      auth: this.buildAuth(configService),
    });
  }

  private buildAuth(
    configService: ConfigService<EnvironmentVariables, true>,
  ): { user: string; pass: string } | undefined {
    const user = configService.get('SMTP_USER', { infer: true });
    const pass = configService.get('SMTP_PASSWORD', { infer: true });

    // Most local mail catchers (e.g. MailDev) don't need auth at all.
    return user && pass ? { user, pass } : undefined;
  }

  async sendConfirmationCode(to: string, code: string, expiresAt: Date): Promise<void> {
    const expiryText = this.expiryText(expiresAt);

    await this.send(
      {
        to,
        subject: 'Confirm your Success Budget account',
        text: `Your confirmation code is ${code}. It expires in ${expiryText}.`,
        html: `<p>Your confirmation code is <strong>${code}</strong>.</p><p>It expires in ${expiryText}.</p>`,
      },
      'confirmation',
    );
  }

  async sendPasswordResetCode(to: string, code: string, expiresAt: Date): Promise<void> {
    const expiryText = this.expiryText(expiresAt);
    const latestOnly = 'Only the code from the most recent email works.';
    const ignore = 'If you did not ask to reset your password, ignore this email; your password stays the same.';

    await this.send(
      {
        to,
        subject: 'Reset your Success Budget password',
        text: `Your password reset code is ${code}. It expires in ${expiryText}. ${latestOnly}\n\n${ignore}`,
        html:
          `<p>Your password reset code is <strong>${code}</strong>.</p>` +
          `<p>It expires in ${expiryText}. ${latestOnly}</p><p>${ignore}</p>`,
      },
      'password reset',
    );
  }

  // A resent code keeps its original expiry, so this is the time actually
  // left, rounded up so it never reads as 0 minutes.
  private expiryText(expiresAt: Date): string {
    const minutesLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000));

    return `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`;
  }

  private async send(message: { to: string; subject: string; text: string; html: string }, kind: string) {
    try {
      await this.transporter.sendMail({ from: this.from, ...message });
    } catch (error) {
      // Never log the code itself or SMTP credentials - just enough to
      // diagnose a delivery problem from the logs. This still flows
      // through the app's pino sink (see src/config/logger.config.ts),
      // not a separate console logger.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send ${kind} email to ${message.to}: ${reason}`);
      throw new ServiceUnavailableException(`Could not send the ${kind} email, please try again shortly`);
    }
  }
}
