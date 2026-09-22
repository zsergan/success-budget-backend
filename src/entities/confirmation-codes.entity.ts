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

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
