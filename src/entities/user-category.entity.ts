import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { User } from './user.entity';
import { TransactionType } from '../shared/enums';

@Entity('user_categories')
export class UserCategory {
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

  @Column({ type: 'varchar', length: 7 })
  color: string;

  @Exclude()
  @Column({ type: 'tinyint' })
  is_active: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
