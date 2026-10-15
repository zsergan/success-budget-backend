import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from './user.entity';

// One row per email address, reused for every new challenge so the hourly
// window survives it. Unknown or unverified addresses get a row with
// user_id and code_hash NULL and go through the same states.
@Entity('password_reset_challenges')
@Index('UQ_password_reset_challenges_email_hash', ['email_hash'], { unique: true })
@Index('UQ_password_reset_challenges_reset_token_hash', ['reset_token_hash'], { unique: true })
export class PasswordResetChallenge {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  // keyed hash of the normalized address, see password-reset-secrets.ts
  @Column({ type: 'char', length: 64, charset: 'ascii', collation: 'ascii_bin' })
  email_hash!: string;

  @Column({ type: 'int', nullable: true })
  user_id!: number | null;

  // keyed hash of the latest code only
  @Column({ type: 'char', length: 64, charset: 'ascii', collation: 'ascii_bin', nullable: true })
  code_hash!: string | null;

  // wrong codes in this challenge; a resend does not reset it
  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts!: number;

  @Column({ type: 'timestamp', precision: 3 })
  started_at!: Date;

  // fixed when the challenge starts; a resend does not extend it
  @Column({ type: 'timestamp', precision: 3 })
  expires_at!: Date;

  // the resend cooldown counts from here
  @Column({ type: 'timestamp', precision: 3 })
  last_requested_at!: Date;

  // set once the code is accepted; the challenge takes no more codes
  @Column({ type: 'timestamp', precision: 3, nullable: true })
  verified_at!: Date | null;

  @Column({ type: 'char', length: 64, charset: 'ascii', collation: 'ascii_bin', nullable: true })
  reset_token_hash!: string | null;

  @Column({ type: 'timestamp', precision: 3, nullable: true })
  reset_token_expires_at!: Date | null;

  @Column({ type: 'timestamp', precision: 3 })
  window_started_at!: Date;

  @Column({ type: 'smallint', unsigned: true, default: 0 })
  window_requests!: number;

  @Column({ type: 'smallint', unsigned: true, default: 0 })
  window_failed_attempts!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_password_reset_challenges_user' })
  user?: User;
}
