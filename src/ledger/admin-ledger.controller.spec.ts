import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffPrincipal } from '../common/staff/staff-auth.guard';
import { account, ANA, CARLOS, createLedgerFixture, MERCHANT_OWNER } from '../testing/ledger-fixture';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { AdminLedgerController } from './admin-ledger.controller';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';

/** Panel administrativo del ledger contra PostgreSQL real: reversos y abonos quedan auditados. */
describeWithDb('AdminLedgerController (PostgreSQL)', () => {
  let fx: Awaited<ReturnType<typeof createLedgerFixture>>;
  let controller: AdminLedgerController;
  let audit: AdminAuditService;
  let anaId: string;
  let carlosId: string;

  const staff = { id: 'emp-1', username: 'laura', role: 'admin', docHash: null, issuedAt: null } as StaffPrincipal;
  const req = { staff };

  beforeAll(async () => {
    fx = await createLedgerFixture();
    audit = new AdminAuditService(fx.dataSource.getRepository(AdminAudit));
    controller = new AdminLedgerController(
      fx.ledger,
      audit,
      fx.dataSource.getRepository(LedgerTransaction),
      fx.dataSource.getRepository(LedgerEntry),
      fx.dataSource.getRepository(LedgerBalance),
    );
  });
  afterAll(() => fx?.drop());

  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    anaId = randomUUID();
    carlosId = randomUUID();
    fx.accounts.clear();
    fx.accounts.set(anaId, account(anaId, '10000000001', ANA));
    fx.accounts.set(carlosId, account(carlosId, '10000000002', CARLOS));
  });

  const fund = (accountId: string, amount: number) =>
    fx.ledger.credit({ accountId, amount, idempotencyKey: randomUUID() });
  const transfer = (amount: number) =>
    fx.ledger.transfer(
      { sourceAccountId: anaId, destinationAccountNumber: '10000000002', amount, idempotencyKey: randomUUID() },
      ANA,
      ANA,
    );

  describe('consulta', () => {
    it('lista las transacciones paginadas y marca cuáles ya fueron reversadas', async () => {
      await fund(anaId, 100_000);
      const enviado = await transfer(10_000);
      await transfer(20_000);
      await controller.reverse(enviado.id, { reason: 'Error del cliente' }, req);

      const todas = await controller.list({});
      expect(todas.total).toBe(4);
      expect(todas.items.find((t) => t.id === enviado.id)).toMatchObject({ reversed: true, amount: 10_000 });
      expect(todas.items.filter((t) => t.reversed)).toHaveLength(1);

      const pagina = await controller.list({ page: 2, limit: 3 });
      expect(pagina.items).toHaveLength(1);
      expect(pagina).toMatchObject({ page: 2, limit: 3, total: 4 });
    });

    it('filtra por cuenta, tipo y fechas', async () => {
      await fund(anaId, 100_000);
      await fund(carlosId, 5_000);
      await transfer(10_000);
      const ayer = new Date(Date.now() - 86_400_000).toISOString();
      const manana = new Date(Date.now() + 86_400_000).toISOString();

      expect((await controller.list({ accountId: carlosId })).total).toBe(2);
      expect((await controller.list({ type: 'transfer' })).total).toBe(1);
      expect((await controller.list({ from: ayer, to: manana })).total).toBe(3);
      expect((await controller.list({ from: manana })).total).toBe(0);
      expect((await controller.list({ to: ayer })).items).toEqual([]);
    });

    it('el detalle trae los asientos y el reverso si lo hay; un id inválido o inexistente da 404', async () => {
      await fund(anaId, 50_000);
      const tx = await transfer(10_000);
      expect((await controller.detail(tx.id)).reversal).toBeNull();
      await controller.reverse(tx.id, { reason: 'Duplicado' }, req);

      const detalle = await controller.detail(tx.id);
      expect(detalle.entries.map((e) => e.amount)).toEqual([-10_000, 10_000]);
      expect(detalle.reversal).toMatchObject({ description: 'Reverso: Duplicado' });
      await expect(controller.detail('no-es-uuid')).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.detail(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('el saldo de una cuenta que nunca se movió es 0 y un id inválido no consulta la base', async () => {
      await fund(anaId, 30_000);
      expect(await controller.balance(anaId)).toMatchObject({ accountId: anaId, balance: 30_000, currency: 'COP' });
      expect(await controller.balance(randomUUID())).toMatchObject({ balance: 0, currency: null, updatedAt: null });
      expect(await controller.balance('no-es-uuid')).toMatchObject({ balance: 0 });
    });

    it('el resumen de 24 h agrupa por tipo y el cuadre sale ok', async () => {
      await fund(anaId, 100_000);
      await transfer(10_000);
      await transfer(5_000);

      const resumen = await controller.summary();
      expect(resumen.byType).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'transfer', count: 2, amount: 15_000 }),
          expect.objectContaining({ type: 'credit', count: 1, amount: 100_000 }),
        ]),
      );
      expect((await controller.reconciliation()).ok).toBe(true);
    });
  });

  describe('reversos y abonos con auditoría', () => {
    it('un reverso devuelve el dinero y queda en la auditoría con el motivo', async () => {
      await fund(anaId, 100_000);
      const tx = await transfer(40_000);
      const reverso = await controller.reverse(tx.id, { reason: 'Transferencia equivocada' }, req);

      expect(await fx.balanceOf(anaId)).toBe(100_000);
      expect(await fx.balanceOf(carlosId)).toBe(0);
      const { items } = await controller.auditLog({});
      expect(items).toEqual([
        expect.objectContaining({
          action: 'transaction.reverse',
          targetId: tx.id,
          staffUsername: 'laura',
          staffRole: 'admin',
          reason: 'Transferencia equivocada',
          details: { reversalId: reverso.id },
        }),
      ]);
    });

    it('no se reversa dos veces ni una transacción inexistente, y no se audita lo que falló', async () => {
      await fund(anaId, 100_000);
      const tx = await transfer(40_000);
      await controller.reverse(tx.id, { reason: 'Primera vez' }, req);

      await expect(controller.reverse(tx.id, { reason: 'Segunda vez' }, req)).rejects.toThrow('ya fue reversada');
      await expect(controller.reverse(randomUUID(), { reason: 'No existe' }, req)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect((await controller.auditLog({})).total).toBe(1);
    });

    it('no reversa si quien recibió ya gastó el dinero', async () => {
      await fund(anaId, 100_000);
      const tx = await transfer(40_000);
      await fx.ledger.debit({ accountId: carlosId, amount: 30_000, idempotencyKey: randomUUID() });

      await expect(controller.reverse(tx.id, { reason: 'Muy tarde' }, req)).rejects.toThrow('Saldo insuficiente');
      expect(await fx.balanceOf(carlosId)).toBe(10_000);
      expect((await controller.auditLog({})).total).toBe(0);
    });

    it('el abono acredita la cuenta y se audita una sola vez aunque se reenvíe el formulario', async () => {
      const dto = {
        accountNumber: '10000000001',
        amount: 80_000,
        reason: 'Ajuste aprobado',
        idempotencyKey: randomUUID(),
      };
      const primero = await controller.credit(dto, req);
      const reenvio = await controller.credit(dto, req);

      expect(reenvio.id).toBe(primero.id);
      expect(primero.amount).toBe(80_000);
      expect(await fx.balanceOf(anaId)).toBe(80_000);
      const { items, total } = await controller.auditLog({});
      expect(total).toBe(1);
      expect(items[0]).toMatchObject({
        action: 'account.credit',
        targetId: anaId,
        details: expect.objectContaining({ transactionId: primero.id, accountNumber: '10000000001', amount: 80_000 }),
      });
    });

    it('un abono rechazado (comercio, máximo) no deja auditoría ni asientos', async () => {
      const tienda = randomUUID();
      fx.accounts.set(tienda, account(tienda, '30000000001', MERCHANT_OWNER, { accountType: 'merchant' }));
      const base = { reason: 'Ajuste aprobado', idempotencyKey: randomUUID() };

      await expect(controller.credit({ ...base, accountNumber: '30000000001', amount: 1_000 }, req)).rejects.toThrow(
        'cuentas de comercio',
      );
      await expect(
        controller.credit(
          { ...base, idempotencyKey: randomUUID(), accountNumber: '10000000001', amount: 10_000_001 },
          req,
        ),
      ).rejects.toThrow('no puede superar');
      expect((await controller.auditLog({})).total).toBe(0);
      expect(await fx.count(LedgerTransaction)).toBe(0);
    });
  });

  describe('bitácora de auditoría', () => {
    it('lista lo más reciente primero, acota el tamaño de página y filtra por objetivo', async () => {
      const staffEntry = (targetId: string) =>
        audit.record(staff, { action: 'test.action', targetType: 'transaction', targetId, reason: '  motivo largo  ' });
      await staffEntry('objetivo-1');
      await staffEntry('objetivo-2');
      await audit.record(staff, { action: 'test.sin-motivo', targetType: 'transaction', targetId: 'objetivo-3' });

      const todas = await audit.list();
      expect(todas.items.map((i) => i.targetId)).toEqual(['objetivo-3', 'objetivo-2', 'objetivo-1']);
      expect(todas.items[0].reason).toBeNull();
      expect(todas.items[1].reason).toBe('motivo largo');

      expect((await audit.list(1, 1000)).limit).toBe(200);
      expect((await audit.list(0, 0)).page).toBe(1);
      expect((await audit.list(1, 50, 'objetivo-2')).items).toHaveLength(1);
      expect(await audit.hasTransactionEntry('test.action', 'tx-que-no-existe')).toBe(false);
    });

    it('registrar dentro de una transacción de la base queda con ella: si se revierte, no queda registro', async () => {
      await expect(
        fx.dataSource.transaction(async (manager) => {
          await audit.record(staff, { action: 'test.tx', targetType: 'account', targetId: 'a1' }, manager);
          throw new Error('se revierte');
        }),
      ).rejects.toThrow('se revierte');
      expect((await audit.list()).total).toBe(0);
    });
  });
});
