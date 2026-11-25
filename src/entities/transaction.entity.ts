import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index, VersionColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Category } from './category.entity';
import { Space } from './space.entity';
import { User } from './user.entity';
import { AssignmentKind, AuthorSource, TransactionType } from '@shared/enums';

@Entity('transactions')
@Index('IDX_transactions_space_date', [
  'space_id',
  'date',
  'order_key',
  'category_id',
  'transaction_type',
  'amount',
  'assignment_kind',
  'assigned_user_id',
])
@Index('IDX_transactions_space_assignment_date', [
  'space_id',
  'assignment_kind',
  'assigned_user_id',
  'date',
  'order_key',
  'category_id',
  'transaction_type',
  'amount',
])
@Index('UQ_transactions_order_key', ['order_key'], { unique: true })
@Index('IDX_transactions_author_user', ['author_user_id'])
@Index('IDX_transactions_assigned_user', ['assigned_user_id'])
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Exclude()
  @Column({ type: 'int' })
  space_id!: number;

  @Exclude()
  @Column({ type: 'int' })
  category_id!: number;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  transaction_type!: TransactionType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount!: string;

  // YYYY-MM-DD: the driver reads DATE columns as strings, never as a Date
  @Column({ type: 'date' })
  date!: string;

  // AUTO_INCREMENT, set by MySQL on insert and never written by the app; it
  // orders the records of one date. A string: a bigint may exceed Number.
  @Exclude()
  @Column({ type: 'bigint', unsigned: true, insert: false, update: false })
  order_key!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @VersionColumn({ type: 'int', unsigned: true, default: 1 })
  version!: number;

  // always set on create; null only after the account was deleted
  @Exclude()
  @Column({ type: 'int', nullable: true })
  author_user_id!: number | null;

  @Exclude()
  @Column({ type: 'enum', enum: AuthorSource })
  author_source!: AuthorSource;

  @Exclude()
  @Column({ type: 'enum', enum: AssignmentKind })
  assignment_kind!: AssignmentKind;

  // set only for a member assignment; null there after the account was deleted
  @Exclude()
  @Column({ type: 'int', nullable: true })
  assigned_user_id!: number | null;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id', foreignKeyConstraintName: 'FK_transactions_space' })
  space?: Space;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category?: Category;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'author_user_id', foreignKeyConstraintName: 'FK_transactions_author_user' })
  author?: User | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_user_id', foreignKeyConstraintName: 'FK_transactions_assigned_user' })
  assignedUser?: User | null;
}
