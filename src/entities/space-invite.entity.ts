import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Space } from './space.entity';
import { SpaceRole } from '@shared/enums';

@Entity('space_invites')
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

  @Exclude()
  @Column({ type: 'timestamp', nullable: true })
  revoked_at!: Date | null;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: Space;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;
}
