import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(configService: ConfigService) {
    this.from = configService.getOrThrow<string>('MAIL_FROM');
    this.transporter = createTransport({
      host: configService.getOrThrow<string>('SMTP_HOST'),
      port: configService.getOrThrow<number>('SMTP_PORT'),
      secure: configService.get<string>('SMTP_SECURE') === 'true',
      auth: this.buildAuth(configService),
    });
  }

  private buildAuth(configService: ConfigService): { user: string; pass: string } | undefined {
    const user = configService.get<string>('SMTP_USER');
    const pass = configService.get<string>('SMTP_PASSWORD');

    // Most local mail catchers (e.g. MailDev) don't need auth at all.
    return user && pass ? { user, pass } : undefined;
  }

  async sendConfirmationCode(to: string, code: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject: 'Confirm your Success Budget account',
        text: `Your confirmation code is ${code}. It expires in 10 minutes.`,
        html: `<p>Your confirmation code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
      });
    } catch (error) {
      // Never log the code itself or SMTP credentials - just enough to
      // diagnose a delivery problem from the logs. This still flows
      // through the app's pino sink (see src/config/logger.config.ts),
      // not a separate console logger.
      this.logger.error(`Failed to send confirmation email to ${to}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Could not send the confirmation email, please try again shortly');
    }
  }
}
