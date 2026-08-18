import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Limit } from '../../entities/limit.entity';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';
import { LimitType } from '../../shared/enums';

@Injectable()
export class LimitsService {
  constructor(
    @InjectRepository(Limit)
    private readonly limitRepository: Repository<Limit>,
  ) {}

  async getOne(limitId: number) {
    return this.limitRepository.findOne({ where: { id: limitId } });
  }

  async getAll(userId: number) {
    return this.limitRepository
      .createQueryBuilder('limit')
      .where('limit.user_id = :userId', { userId })
      .leftJoinAndSelect('limit.category', 'category')
      .getMany();
  }

  async create(userId: number, createLimit: CreateLimitDto) {
    const limit = this.limitRepository.create({
      ...createLimit,
      user_id: userId,
      limit_type: createLimit.category_id ? LimitType.CATEGORY : LimitType.OTHERS,
    });

    return await this.limitRepository.save(limit);
  }

  async update(limitId: number, updateLimit: UpdateLimitDto) {
    await this.limitRepository.update(
      { id: limitId },
      {
        ...updateLimit,
        category_id: updateLimit.category_id ? updateLimit.category_id : null,
        limit_type: updateLimit.category_id ? LimitType.CATEGORY : LimitType.OTHERS,
      },
    );
  }
}
