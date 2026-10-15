import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetChallenge } from '@entities/password-reset-challenge.entity';
import { MailModule } from '@modules/mail/mail.module';

@Module({
  imports: [TypeOrmModule.forFeature([PasswordResetChallenge]), MailModule],
  controllers: [PasswordResetController],
  providers: [PasswordResetService],
})
export class PasswordResetModule {}
