import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';

import { ConfirmationType, ConfirmationCodeSendStatus } from '@shared/enums';
import { User } from './user.entity';

@Entity('confirmation_codes')
export class ConfirmationCode {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'varchar', length: '6' })
  confirmation_code: string;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'enum', enum: ConfirmationType })
  confirmation_type: ConfirmationType;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @Column({ type: 'timestamp' })
  expired_at: Date;

  // set only once a send attempt is *confirmed* delivered to the SMTP
  // server - see last_attempted_at for cooldown/rate-limit purposes
  @Column({ type: 'timestamp', nullable: true })
  last_sent_at: Date | null;

  // set whenever a send is attempted, successful or not - this is what the
  // resend cooldown is actually measured from, so a failed attempt still
  // throttles immediate retries against a struggling SMTP server
  @Column({ type: 'timestamp', nullable: true })
  last_attempted_at: Date | null;

  @Column({ type: 'enum', enum: ConfirmationCodeSendStatus, default: ConfirmationCodeSendStatus.PENDING })
  send_status: ConfirmationCodeSendStatus;

  // Bumped every time reserveSend() reserves a send attempt. markSent()/
  // markFailed() only apply if this still matches the attempt they were
  // given - otherwise a slow, stale attempt (e.g. one SMTP call that hangs
  // past a newer, faster resend) can no longer overwrite a status a later
  // attempt already settled. See ConfirmationCodesService.reserveSend().
  @Column({ type: 'int', default: 0 })
  send_attempt_id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}
