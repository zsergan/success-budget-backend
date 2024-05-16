import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

import { TransactionType } from '../shared/enums';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  transaction_type: TransactionType;
}
