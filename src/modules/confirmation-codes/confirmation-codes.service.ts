import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConfirmationCode } from '@entities/confirmation-codes.entity';
import { CreateConfirmationCodeDto } from './dto/create-confirmation-code.dto';
import { ConfirmationType } from '@shared/enums';
import { CONFIRMATION_CODE_RESEND_COOLDOWN_MS } from '@shared/constants';
import { generateRandomNumberString } from '@shared/utils';

export interface EnsuredConfirmationCode {
  code: string;
  // false means a valid code already exists and was sent recently enough
  // (see CONFIRMATION_CODE_RESEND_COOLDOWN_MS) - the caller should not
  // attempt to send another email for it.
  shouldSend: boolean;
}

@Injectable()
export class ConfirmationCodesService {
  constructor(
    @InjectRepository(ConfirmationCode)
    private readonly confirmationCodeRepository: Repository<ConfirmationCode>,
  ) {}

  async getOne(userId: number, confirmationType: ConfirmationType): Promise<ConfirmationCode> {
    return this.confirmationCodeRepository
      .createQueryBuilder('confirmation_code')
      .where({ user_id: userId, confirmation_type: confirmationType })
      .andWhere('confirmation_code.expired_at >= :current_date', { current_date: new Date() })
      .getOne();
  }

  async create(createConfirmationCodeDto: CreateConfirmationCodeDto): Promise<ConfirmationCode> {
    const confirmation_code = this.confirmationCodeRepository.create({
      ...createConfirmationCodeDto,
      created_at: new Date(),
      expired_at: new Date(Date.now() + 1000 * 60 * 10),
      last_sent_at: new Date(),
    });

    return this.confirmationCodeRepository.save(confirmation_code);
  }

  async ensureCode(userId: number, confirmationType: ConfirmationType): Promise<EnsuredConfirmationCode> {
    const existing = await this.getOne(userId, confirmationType);

    if (!existing) {
      const created = await this.create({
        user_id: userId,
        confirmation_code: generateRandomNumberString(),
        confirmation_type: confirmationType,
      });

      return { code: created.confirmation_code, shouldSend: true };
    }

    const elapsedSinceLastSend = existing.last_sent_at ? Date.now() - existing.last_sent_at.getTime() : Infinity;
    const shouldSend = elapsedSinceLastSend >= CONFIRMATION_CODE_RESEND_COOLDOWN_MS;

    if (shouldSend) {
      await this.confirmationCodeRepository.update(existing.id, { last_sent_at: new Date() });
    }

    return { code: existing.confirmation_code, shouldSend };
  }

  async incrementAttempts(id: number): Promise<void> {
    await this.confirmationCodeRepository.increment({ id }, 'attempts', 1);
  }

  async expire(userId: number, confirmationType: ConfirmationType): Promise<void> {
    const confirmationCode = await this.confirmationCodeRepository.findOne({
      where: { user_id: userId, confirmation_type: confirmationType },
    });

    if (confirmationCode) {
      await this.confirmationCodeRepository.update(confirmationCode.id, { expired_at: confirmationCode.created_at });
    }
  }
}
