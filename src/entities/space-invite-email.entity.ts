import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// One row per scheduled invitation email, kept for the 24-hour limit window
// and purged after it. No foreign keys: deleting an invitation, a space or
// an account must not reset the limits of the address it emailed.
@Entity('space_invite_emails')
@Index('IDX_space_invite_emails_invite', ['invite_id', 'scheduled_at'])
@Index('IDX_space_invite_emails_space', ['space_id', 'scheduled_at'])
@Index('IDX_space_invite_emails_email', ['email', 'scheduled_at'])
@Index('IDX_space_invite_emails_sender', ['sender_user_id', 'scheduled_at'])
@Index('IDX_space_invite_emails_scheduled_at', ['scheduled_at'])
export class SpaceInviteEmail {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ type: 'int' })
  invite_id!: number;

  @Column({ type: 'int' })
  space_id!: number;

  // normalized, as stored on the invitation
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'int' })
  sender_user_id!: number;

  @Column({ type: 'timestamp', precision: 3 })
  scheduled_at!: Date;
}
