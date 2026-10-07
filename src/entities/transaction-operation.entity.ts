import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Space } from './space.entity';

export const TRANSACTION_OPERATION_SCOPE = 'UQ_transaction_operations_space_operation';

// The lasting record that a client's create committed, kept as long as the
// space. transaction_id has no foreign key, so the row outlives the deleted
// transaction and still tells the client its create did happen.
@Entity('transaction_operations')
@Index(TRANSACTION_OPERATION_SCOPE, ['space_id', 'operation_id'], { unique: true })
@Index('UQ_transaction_operations_transaction', ['transaction_id'], { unique: true })
export class TransactionOperation {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'int' })
  space_id!: number;

  // lowercase UUID
  @Column({ type: 'char', length: 36, charset: 'ascii', collation: 'ascii_bin' })
  operation_id!: string;

  @Column({ type: 'varchar', length: 36 })
  transaction_id!: string;

  @Column({ type: 'timestamp', precision: 3 })
  created_at!: Date;

  @Column({ type: 'timestamp', precision: 3, nullable: true })
  deleted_at!: Date | null;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id', foreignKeyConstraintName: 'FK_transaction_operations_space' })
  space?: Space;
}
