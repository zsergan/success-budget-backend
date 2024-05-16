import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('currencies')
export class Currency {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 5 })
  code: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;
}
