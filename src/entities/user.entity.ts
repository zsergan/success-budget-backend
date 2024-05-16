import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, BeforeInsert } from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcrypt';

import { Currency } from './currency.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Exclude()
  @Column({ type: 'varchar', length: 255 })
  password: string;

  @BeforeInsert()
  async hashPassword() {
    this.password = await bcrypt.hash(this.password, 10);
  }

  @Exclude()
  @Column({ type: 'int' })
  base_currency_id: number;

  @ManyToOne(() => Currency)
  @JoinColumn({ name: 'base_currency_id' })
  baseCurrency: Currency;
}
