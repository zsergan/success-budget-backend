import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, Index } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Space } from './space.entity';
import { User } from './user.entity';
import { SpaceInviteEmailStatus, SpaceRole } from '@shared/enums';

@Entity('space_invites')
@Index('IDX_space_invites_email_due', ['email_status', 'email_next_attempt_at'])
export class SpaceInvite {
  @PrimaryGeneratedColumn()
  id!: number;

  @Exclude()
  @Column({ type: 'int' })
  space_id!: number;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Exclude()
  @Column({ type: 'varchar', length: 6 })
  code!: string;

  @Column({ type: 'enum', enum: SpaceRole, default: SpaceRole.MEMBER })
  role!: SpaceRole;

  @Exclude()
  @Column({ type: 'timestamp' })
  expires_at!: Date;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  accepted_at!: Date | null;

  // null for invitations accepted before it was recorded, or when that user was deleted
  @Exclude()
  @Column({ type: 'int', nullable: true })
  accepted_by_user_id!: number | null;

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  revoked_at!: Date | null;

  // signed into the link token (space-invite-links.ts); null until the first email of a legacy invitation
  @Exclude()
  @Column({ type: 'char', length: 32, charset: 'ascii', collation: 'ascii_bin', nullable: true })
  token_nonce!: string | null;

  @Exclude()
  @Column({ type: 'enum', enum: SpaceInviteEmailStatus, default: SpaceInviteEmailStatus.NOT_SENT })
  email_status!: SpaceInviteEmailStatus;

  // attempts of the latest scheduled email
  @Exclude()
  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  email_attempts!: number;

  // an attempt writes its result only while this is still its id
  @Exclude()
  @Column({ type: 'int', unsigned: true, default: 0 })
  email_attempt_id!: number;

  @Exclude()
  @Column({ type: 'timestamp', precision: 3, nullable: true })
  email_next_attempt_at!: Date | null;

  @Exclude()
  @Column({ type: 'timestamp', precision: 3, nullable: true })
  email_lease_expires_at!: Date | null;

  @Exclude()
  @Column({ type: 'timestamp', precision: 3, nullable: true })
  email_last_sent_at!: Date | null;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: Space;

  @Exclude()
  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'accepted_by_user_id', foreignKeyConstraintName: 'FK_space_invites_accepted_by_user' })
  accepted_by?: User;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;
}
