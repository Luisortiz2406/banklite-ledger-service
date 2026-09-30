import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('ledger_balances')
export class LedgerBalance {
  @PrimaryColumn({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  balance: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}