import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';

import { Space } from './space.entity';
import { AppColor } from '@shared/enums';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn()
  id!: number;

  @Exclude()
  @Column({ type: 'int' })
  space_id!: number;

  @Column({ type: 'varchar', length: 255 })
  wallet_name!: string;

  @Column({ type: 'enum', enum: AppColor })
  design!: AppColor;

  @Exclude()
  @Column({ type: 'tinyint', default: 0 })
  is_deleted!: number;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  deleted_at!: Date | null;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: Space;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at!: Date;
}

// balance is derived from the wallet's transactions, not a column - only
// responses that compute it carry it
export type WalletWithBalance = Wallet & { balance: number };
