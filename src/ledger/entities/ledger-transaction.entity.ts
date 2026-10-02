import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// transfer: entre cuentas de clientes. credit: abono externo (clave interna).
// deposit: consignación de prueba. debit: cargo interno (p. ej. compra con tarjeta).
// reversal: anula otra transacción con los asientos contrarios.
export type LedgerTransactionType = 'transfer' | 'credit' | 'deposit' | 'debit' | 'reversal';

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
  type: LedgerTransactionType;

  @Column({ name: 'source_account_id', type: 'uuid', nullable: true })
  sourceAccountId: string | null;

  @Column({ name: 'destination_account_id', type: 'uuid' })
  destinationAccountId: string;

  // Números de cuenta al momento del movimiento, para mostrarlos enmascarados
  // sin exponer el UUID interno de la cuenta de otra persona.
  @Column({ name: 'source_account_number', type: 'varchar', length: 11, nullable: true })
  sourceAccountNumber: string | null;

  @Column({ name: 'destination_account_number', type: 'varchar', length: 11, nullable: true })
  destinationAccountNumber: string | null;

  // Solo en reversos: la transacción que se anula. Único para que no se reverse dos veces.
  @Index({ unique: true, where: 'reversed_transaction_id IS NOT NULL' })
  @Column({ name: 'reversed_transaction_id', type: 'uuid', nullable: true })
  reversedTransactionId: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ length: 3 })
  currency: string;

  @Column({ type: 'varchar', length: 140 })
  description: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
