import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { User } from './user.entity';
import { Category } from './category.entity';
import { LimitType } from '../shared/enums';

@Entity('limits')
export class Limit {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  @Exclude()
  @Column({ type: 'int', nullable: true })
  category_id: number;

  @Column({ type: 'enum', enum: LimitType })
  limit_type: LimitType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Exclude()
  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Category)
  @JoinColumn({ name: 'category_id' })
  category: Category;
}
