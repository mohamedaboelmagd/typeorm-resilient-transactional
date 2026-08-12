import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('account')
export class Account {
  @PrimaryColumn('text')
  id!: string;

  /** Stored as bigint, so it arrives as a string. Cents, not floats. */
  @Column('bigint')
  balance!: string;
}
