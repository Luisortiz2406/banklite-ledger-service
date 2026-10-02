import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Patrón outbox: el evento se guarda en la MISMA transacción que los asientos,
 * así nunca se mueve dinero sin que quede su evento pendiente. OutboxService lo
 * publica en RabbitMQ y marca published_at; si RabbitMQ está caído, se reintenta.
 * occurred_at queda fijo para que notification-service deduplique las reentregas.
 */
@Entity('ledger_outbox')
@Index('idx_ledger_outbox_pending', ['publishedAt', 'createdAt'])
export class LedgerOutbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'routing_key', type: 'varchar' })
  routingKey: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
