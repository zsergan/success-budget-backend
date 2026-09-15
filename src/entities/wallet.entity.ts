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
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  space_id: number;

  @Column({ type: 'varchar', length: 255 })
  wallet_name: string;

  // derived from the wallet's own transactions, not a stored column -
  // populated by the service before the entity is returned/serialized
  balance: number;

  @Column({ type: 'enum', enum: AppColor })
  design: AppColor;

  @Exclude()
  @Column({ type: 'tinyint', default: 0 })
  is_deleted: number;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  deleted_at: Date;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space: Space;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
