import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { User } from './user.entity';
import { Currency } from './currency.entity';

@Entity('holdings')
export class Holding {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  balance: number;

  @Exclude()
  @Column({ type: 'int' })
  currency_id: number;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;
}
