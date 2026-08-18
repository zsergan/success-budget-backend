import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConfirmationCode } from '../../entities/confirmation-codes.entity';
import { CreateConfirmationCodeDto } from './dto/create-confirmation-code.dto';
import { ConfirmationType } from '../../shared/enums';

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

  async create(createConfirmationCodeDto: CreateConfirmationCodeDto): Promise<void> {
    const confirmation_code = this.confirmationCodeRepository.create({
      ...createConfirmationCodeDto,
      created_at: new Date(),
      expired_at: new Date(Date.now() + 1000 * 60 * 10),
    });

    await this.confirmationCodeRepository.save(confirmation_code);
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
