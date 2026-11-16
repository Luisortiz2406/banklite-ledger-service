import { randomUUID } from 'crypto';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { account, ANA, createLedgerFixture } from '../testing/ledger-fixture';
import { ensureLedgerAppendOnly } from './append-only.service';

/**
 * Los asientos del ledger no se modifican ni se borran: lo hace valer la base con un
 * trigger, no solo el código. Corre contra Postgres real.
 */
describeWithDb('ledger_entries append-only (trigger)', () => {
  let fx: Awaited<ReturnType<typeof createLedgerFixture>>;
  let anaId: string;

  beforeAll(async () => {
    fx = await createLedgerFixture();
    await ensureLedgerAppendOnly(fx.dataSource);
  });
  afterAll(() => fx?.drop());

  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    anaId = randomUUID();
    fx.accounts.clear();
    fx.accounts.set(anaId, account(anaId, '10000000001', ANA));
  });

  const fund = (amount: number) =>
    fx.ledger.credit({ accountId: anaId, amount, idempotencyKey: randomUUID(), description: 'Fondeo de prueba' });

  it('crear el trigger dos veces (dos arranques) deja uno solo y no falla', async () => {
    await ensureLedgerAppendOnly(fx.dataSource);
    await ensureLedgerAppendOnly(fx.dataSource);

    const triggers = await fx.dataSource.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'ledger_entries'::regclass AND NOT tgisinternal`,
    );
    expect(triggers).toEqual([{ tgname: 'ledger_entries_append_only' }]);
  });

  it('un UPDATE sobre un asiento falla y el asiento queda igual', async () => {
    const tx = await fund(50_000);

    await expect(fx.dataSource.query(`UPDATE ledger_entries SET amount = amount + 1`)).rejects.toThrow(
      /append-only: no se permite UPDATE/,
    );

    expect((await fx.entriesOf(tx.id)).map((e) => Number(e.amount)).sort((a, b) => a - b)).toEqual([-50_000, 50_000]);
  });

  it('un DELETE sobre un asiento falla y no se borra nada', async () => {
    const tx = await fund(50_000);

    await expect(fx.dataSource.query(`DELETE FROM ledger_entries`)).rejects.toThrow(
      /append-only: no se permite DELETE/,
    );
    await expect(fx.dataSource.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [tx.id])).rejects.toThrow(
      /append-only/,
    );

    expect(await fx.entriesOf(tx.id)).toHaveLength(2);
  });

  it('los flujos normales siguen funcionando: abono, cargo, reverso como asientos nuevos y cuadre', async () => {
    await fund(100_000);
    const cargo = await fx.ledger.debit({ accountId: anaId, amount: 30_000, idempotencyKey: randomUUID() });
    expect(await fx.balanceOf(anaId)).toBe(70_000);

    const reverso = await fx.ledger.reverse(cargo.id, { idempotencyKey: randomUUID(), reason: 'Compra anulada' });

    expect(reverso).toMatchObject({ type: 'reversal', reversedTransactionId: cargo.id });
    expect(await fx.balanceOf(anaId)).toBe(100_000);
    expect(await fx.entriesOf(cargo.id)).toHaveLength(2); // el cargo original no se tocó
    expect(await fx.entriesOf(reverso.id)).toHaveLength(2); // el reverso son asientos nuevos
    expect(await fx.count((await import('./entities/ledger-entry.entity')).LedgerEntry)).toBe(6);
    expect(await fx.ledger.reconcile()).toMatchObject({ ok: true, balanceMismatches: [], unbalancedTransactions: [] });
  });

  it('vaciar las tablas entre pruebas (TRUNCATE) no se ve afectado', async () => {
    await fund(10_000);

    await expect(truncateAll(fx.dataSource)).resolves.toBeUndefined();
    expect(await fx.count((await import('./entities/ledger-entry.entity')).LedgerEntry)).toBe(0);
  });
});
