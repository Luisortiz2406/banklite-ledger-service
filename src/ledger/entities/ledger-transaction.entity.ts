import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ledger_transactions')
export class LedgerTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar' })
  type: 'transfer' | 'credit';

  @Column({ name: 'source_account_id', type: 'uuid', nullable: true })
  sourceAccountId: string | null;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 140 })
  description: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}