import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * ledger_entries es append-only: un asiento nunca se cambia ni se borra; un error se
 * corrige con un asiento nuevo (reverso). Esta regla se hace valer en la base con un
 * trigger BEFORE UPDATE OR DELETE que lanza excepción, aunque alguien entre por SQL.
 *
 * Es idempotente: se puede correr en cada arranque. `CREATE OR REPLACE` deja el mismo
 * resultado si el trigger ya existe, y el candado de aviso evita que dos instancias
 * que arrancan a la vez choquen al reemplazar la función.
 */
export const APPEND_ONLY_LOCK_KEY = 726_001;

const SQL_FUNCTION = `
CREATE OR REPLACE FUNCTION ledger_entries_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger_entries es append-only: no se permite % (los ajustes se hacen con asientos nuevos)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql`;

const SQL_TRIGGER = `
CREATE OR REPLACE TRIGGER ledger_entries_append_only
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_entries_append_only()`;

export async function ensureLedgerAppendOnly(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.startTransaction();
    await runner.query('SELECT pg_advisory_xact_lock($1)', [APPEND_ONLY_LOCK_KEY]);
    await runner.query(SQL_FUNCTION);
    await runner.query(SQL_TRIGGER);
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

@Injectable()
export class AppendOnlyService implements OnModuleInit {
  private readonly logger = new Logger('AppendOnly[ledger-service]');

  constructor(private readonly dataSource: DataSource) {}

  /** TypeORM ya sincronizó las tablas cuando esto corre. Si falla, el servicio sigue y avisa. */
  async onModuleInit() {
    try {
      await ensureLedgerAppendOnly(this.dataSource);
      this.logger.log('ledger_entries protegida contra UPDATE y DELETE (trigger append-only).');
    } catch (error) {
      this.logger.error(`No se pudo crear el trigger append-only de ledger_entries: ${(error as Error).message}`);
    }
  }
}
