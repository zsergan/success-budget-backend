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

import { AppColor, TransactionType } from '@shared/enums';
import { User } from './user.entity';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'varchar', length: 20 })
  name: string;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  transaction_type: TransactionType;

  @Column({ type: 'varchar', length: 255 })
  icon: string;

  @Column({ type: 'enum', enum: AppColor })
  color: AppColor;

  @Column({ type: 'tinyint' })
  is_active: number;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  archived_at: Date | null;

  @Exclude()
  @Column({ type: 'int' })
  sort: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
