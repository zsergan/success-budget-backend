import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Wallet } from '../../entities/wallet.entity';
import type { CreateWalletDto } from './dto/create-wallet.dto';
import type { UpdateWalletDto } from './dto/update-wallet.dto';

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  async getOne(walletId: number): Promise<Wallet> {
    return await this.walletRepository.findOne({ where: { id: walletId } });
  }

  async getAll(userId: number): Promise<Wallet[]> {
    return await this.walletRepository
      .createQueryBuilder('wallet')
      .innerJoinAndSelect('wallet.currency', 'currency')
      .where({ user_id: userId, is_deleted: 0 })
      .getMany();
  }

  async create(userId: number, createWalletDto: CreateWalletDto): Promise<Wallet> {
    const wallet = this.walletRepository.create({
      ...createWalletDto,
      user_id: userId,
    });
    await this.walletRepository.save(wallet);

    return wallet;
  }

  async update(walletId: number, updateWalletDto: UpdateWalletDto): Promise<void> {
    await this.walletRepository.update({ id: walletId }, updateWalletDto);
  }

  async delete(walletId: number): Promise<void> {
    await this.walletRepository.update({ id: walletId }, { is_deleted: 1, deleted_at: new Date() });
  }
}
