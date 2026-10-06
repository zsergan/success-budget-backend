import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const IDEMPOTENCY_KEY_SCOPE = 'UQ_idempotency_keys_scope';

// No foreign keys: rows expire within a day, and an FK would make every
// claim lock the user and space rows too.
@Entity('idempotency_keys')
@Index(IDEMPOTENCY_KEY_SCOPE, ['user_id', 'space_id', 'operation', 'idempotency_key'], { unique: true })
@Index('IDX_idempotency_keys_expires_at', ['expires_at'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'int' })
  user_id!: number;

  @Column({ type: 'int' })
  space_id!: number;

  @Column({ type: 'varchar', length: 64, charset: 'ascii', collation: 'ascii_bin' })
  operation!: string;

  @Column({ type: 'varchar', length: 255, charset: 'ascii', collation: 'ascii_bin' })
  idempotency_key!: string;

  // sha256 of the request: a reused key with different content is refused
  @Column({ type: 'char', length: 64, charset: 'ascii', collation: 'ascii_bin' })
  request_hash!: string;

  // the JSON body of the original success; null only inside the claiming transaction
  @Column({ type: 'json', nullable: true })
  response_body!: object | boolean | null;

  @Column({ type: 'timestamp', precision: 3 })
  created_at!: Date;

  @Column({ type: 'timestamp', precision: 3 })
  expires_at!: Date;
}
