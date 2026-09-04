import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Wallet } from './wallet.entity';
import { Category } from './category.entity';
import { Currency } from './currency.entity';
import { TransactionType } from '@shared/enums';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Exclude()
  @Column({ type: 'int' })
  wallet_id: number;

  @Exclude()
  @Column({ type: 'int' })
  category_id: number;

  @Exclude()
  @Column({ type: 'int' })
  currency_id: number;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  transaction_type: TransactionType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  timestamp: Date;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'wallet_id' })
  wallet: Wallet;

  @ManyToOne(() => Category, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @ManyToOne(() => Currency, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;
}
