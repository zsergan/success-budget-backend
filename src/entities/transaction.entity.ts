import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Wallet } from './wallet.entity';
import { UserCategory } from './user-category.entity';
import { Currency } from './currency.entity';
import { TransactionType } from '../shared/enums';

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Exclude()
  @Column({ type: 'int' })
  wallet_id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_category_id: number;

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

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToOne(() => Wallet)
  @JoinColumn({ name: 'wallet_id' })
  wallet: Wallet;

  @ManyToOne(() => UserCategory)
  @JoinColumn({ name: 'user_category_id' })
  user_category: UserCategory;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;
}
