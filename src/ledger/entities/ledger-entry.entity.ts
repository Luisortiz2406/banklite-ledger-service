import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ledger_entries')
@Index('idx_ledger_entries_account_created', ['accountId', 'createdAt'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ length: 3 })
  currency: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
