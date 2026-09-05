import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';

import { User } from './user.entity';
import { Category } from './category.entity';
import { LimitType } from '@shared/enums';

@Entity('limits')
export class Limit {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  // only meaningful for a group limit (2+ categories) - a single-category
  // limit uses the category's own name, a total limit uses a fixed label,
  // both client-side
  @Column({ type: 'varchar', length: 60, nullable: true })
  name: string | null;

  @Column({ type: 'enum', enum: LimitType })
  limit_type: LimitType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Exclude()
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // 0 categories = monthly total limit, 1 = single-category, 2+ = group
  @ManyToMany(() => Category, { onDelete: 'RESTRICT' })
  @JoinTable({
    name: 'limit_categories',
    joinColumn: { name: 'limit_id' },
    inverseJoinColumn: { name: 'category_id' },
  })
  categories: Category[];

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
