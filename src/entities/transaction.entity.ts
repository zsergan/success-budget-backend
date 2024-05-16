import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';

import { Holding } from './holding.entity';
import { Category } from './category.entity';
import { TransactionType } from '../shared/enums';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  holding_id: number;

  @Column({ type: 'int' })
  category_id: number;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  transaction_type: TransactionType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToOne(() => Holding)
  @JoinColumn({ name: 'holding_id' })
  holding: Holding;

  @ManyToOne(() => Category)
  @JoinColumn({ name: 'category_id' })
  category: Category;
}
