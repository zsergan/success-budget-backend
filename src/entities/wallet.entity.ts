import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { User } from './user.entity';
import { Currency } from './currency.entity';
import { WalletDesign } from '../shared/enums';

@Entity('wallets')
export class Wallet {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'varchar', length: 255 })
  wallet_name: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  balance: number;

  @Column({ type: 'enum', enum: WalletDesign })
  design: WalletDesign;

  @Exclude()
  @Column({ type: 'int' })
  currency_id: number;

  @Exclude()
  @Column({ type: 'tinyint', default: 0 })
  is_deleted: number;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  deleted_at: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;
}
