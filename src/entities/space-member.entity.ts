import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, Unique } from 'typeorm';
import { Exclude } from 'class-transformer';

import { Space } from './space.entity';
import { User } from './user.entity';
import { SpaceRole } from '@shared/enums';

@Entity('space_members')
@Unique(['space_id', 'user_id'])
export class SpaceMember {
  @PrimaryGeneratedColumn()
  id: number;

  @Exclude()
  @Column({ type: 'int' })
  space_id: number;

  @Exclude()
  @Column({ type: 'int' })
  user_id: number;

  @Column({ type: 'enum', enum: SpaceRole })
  role: SpaceRole;

  @ManyToOne(() => Space, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'space_id' })
  space?: Space;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
