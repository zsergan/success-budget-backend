import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  BeforeInsert,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import * as bcrypt from 'bcrypt';

import { PASSWORD_HASH_ROUNDS } from '@shared/constants';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index('UQ_users_email', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Exclude()
  @Column({ type: 'varchar', length: 255 })
  password!: string;

  @BeforeInsert()
  async hashPassword() {
    this.password = await bcrypt.hash(this.password, PASSWORD_HASH_ROUNDS);
  }

  @Exclude()
  @Column({ type: 'tinyint', default: 0 })
  email_verified!: number;

  // access tokens issued for an older version are rejected
  @Exclude()
  @Column({ type: 'int', unsigned: true, default: 1 })
  auth_version!: number;

  @CreateDateColumn({ type: 'timestamp' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at!: Date;
}
