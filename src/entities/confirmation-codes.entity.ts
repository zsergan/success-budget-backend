import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';

import { ConfirmationType } from '../shared/enums';
import { User } from './user.entity';

@Entity('confirmation_codes')
export class ConfirmationCode {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'varchar', length: '6' })
  confirmation_code: string;

  @Column({ type: 'enum', enum: ConfirmationType })
  confirmation_type: ConfirmationType;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  created_at: Date;

  @Column({ type: 'timestamp' })
  expired_at: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;
}
