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
    // a resent code keeps its original expiry, not a fresh 10 minutes - say
    // how long is actually left, rounded up so "expires in 1 minute" never
    // reads as "expires in 0 minutes"
    const minutesLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000));
    const expiryText = `${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}`;

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: 'Confirm your Success Budget account',
        text: `Your confirmation code is ${code}. It expires in ${expiryText}.`,
        html: `<p>Your confirmation code is <strong>${code}</strong>.</p><p>It expires in ${expiryText}.</p>`,
      });
    } catch (error) {
      // Never log the code itself or SMTP credentials - just enough to
      // diagnose a delivery problem from the logs. This still flows
      // through the app's pino sink (see src/config/logger.config.ts),
      // not a separate console logger.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send confirmation email to ${to}: ${reason}`);
      throw new ServiceUnavailableException('Could not send the confirmation email, please try again shortly');
    }
  }
}
