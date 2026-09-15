import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';

import { Currency } from './currency.entity';
import { SpaceType } from '@shared/enums';

@Entity('spaces')
export class Space {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'enum', enum: SpaceType })
  type: SpaceType;

  @Exclude()
  @Column({ type: 'int' })
  currency_id: number;

  @ManyToOne(() => Currency, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'currency_id' })
  currency: Currency;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
