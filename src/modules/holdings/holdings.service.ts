import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Holding } from '../../entities/holding.entity';
import type { CreateHoldingDto } from './dto/create-holding.dto';
import type { UpdateHoldingDto } from './dto/update-holding.dto';

@Injectable()
export class HoldingsService {
  constructor(
    @InjectRepository(Holding)
    private readonly holdingRepository: Repository<Holding>,
  ) {}

  async getOne(holdingId: number): Promise<Holding> {
    return await this.holdingRepository.findOne({ where: { id: holdingId } });
  }

  async getAll(userId: number): Promise<Holding[]> {
    return await this.holdingRepository
      .createQueryBuilder('holding')
      .innerJoinAndSelect('holding.currency', 'currency')
      .where({ user_id: userId })
      .getMany();
  }

  async create(userId: number, createHoldingDto: CreateHoldingDto): Promise<Holding> {
    const holding = this.holdingRepository.create({ ...createHoldingDto, user_id: userId });
    await this.holdingRepository.save(holding);

    return holding;
  }

  async update(holdingId: number, updateHoldingDto: UpdateHoldingDto): Promise<void> {
    await this.holdingRepository.update({ id: holdingId }, updateHoldingDto);
  }
}
