import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AccountsClientService, LedgerAccountInfo } from './accounts-client.service';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerOutbox } from './entities/ledger-outbox.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { EventPublisherService } from './event-publisher.service';
import { LedgerService } from './ledger.service';
import { OutboxService } from './outbox.service';

/**
 * Reglas del ledger contra un PostgreSQL real (las transacciones SERIALIZABLE,
 * FOR UPDATE y las claves únicas no se pueden simular con mocks). Cada corrida
 * crea una base temporal y la borra al final (ver testing/test-database.ts).
 */

const DEMO_DEPOSIT_COP = '00000000-0000-4000-8000-000000000003';
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';

const account = (id: string, accountNumber: string, idUser: string, status = 'active'): LedgerAccountInfo => ({
  id,
  accountNumber,
  accountType: 'savings',
  idUser,
  currency: 'COP',
  status,
  dailyLimit: 5_000_000,
  monthlyLimit: 50_000_000,
});

describeWithDb('LedgerService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let ledger: LedgerService;
  let accounts: Map<string, LedgerAccountInfo>;
  let anaId: string;
  let carlosId: string;

  // account-service simulado: el token de acceso es el idUser del titular.
  const accountsClient = {
    getOwnedAccount: async (id: string, token: string) => {
      const found = accounts.get(id);
      if (!found || found.idUser !== token) throw new ForbiddenException('No tienes acceso a esta cuenta.');
      return found;
    },
    getInternalAccount: async (id: string) => {
      const found = accounts.get(id);
      if (!found) throw new NotFoundException('Cuenta no encontrada.');
      return found;
    },
    getInternalAccountByNumber: async (number: string) => {
      const found = [...accounts.values()].find((a) => a.accountNumber === number);
      if (!found) throw new NotFoundException('Cuenta destino no encontrada.');
      return found;
    },
    getLimits: async (id: string) => {
      const found = accounts.get(id)!;
      return { dailyLimit: found.dailyLimit!, monthlyLimit: found.monthlyLimit! };
    },
  } as unknown as AccountsClientService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('ledger', [
      LedgerBalance,
      LedgerEntry,
      LedgerTransaction,
      LedgerOutbox,
    ]));
    // Sin RabbitMQ: los eventos quedan en ledger_outbox, que es lo que se verifica.
    const publisher = { isReady: () => false } as unknown as EventPublisherService;
    ledger = new LedgerService(
      dataSource,
      dataSource.getRepository(LedgerBalance),
      dataSource.getRepository(LedgerEntry),
      dataSource.getRepository(LedgerTransaction),
      accountsClient,
      new OutboxService(dataSource, publisher),
      new ConfigService({ NODE_ENV: 'test' }),
    );
  });

  afterAll(() => drop?.());

  beforeEach(async () => {
    await truncateAll(dataSource);
    anaId = randomUUID();
    carlosId = randomUUID();
    accounts = new Map([
      [anaId, account(anaId, '10000000001', ANA)],
      [carlosId, account(carlosId, '10000000002', CARLOS)],
    ]);
  });

  const credit = (accountId: string, amount: number) =>
    ledger.credit({ accountId, amount, idempotencyKey: randomUUID(), description: 'Fondeo de prueba' });
  const transfer = (amount: number, idempotencyKey = randomUUID(), from = anaId, toNumber = '10000000002') =>
    ledger.transfer(
      { sourceAccountId: from, destinationAccountNumber: toNumber, amount, idempotencyKey, description: 'Prueba' },
      accounts.get(from)!.idUser,
      accounts.get(from)!.idUser,
    );
  const balanceOf = async (accountId: string) =>
    Number((await dataSource.getRepository(LedgerBalance).findOneBy({ accountId }))?.balance ?? 0);
  const entriesOf = (transactionId: string) => dataSource.getRepository(LedgerEntry).findBy({ transactionId });
  const count = (entity: typeof LedgerTransaction | typeof LedgerEntry | typeof LedgerOutbox) =>
    dataSource.getRepository(entity).count();

  describe('doble partida', () => {
    it('una transferencia crea dos asientos que suman cero y mueve los dos saldos', async () => {
      await credit(anaId, 100_000);
      const tx = await transfer(30_000);

      const entries = await entriesOf(tx.id);
      expect(entries).toHaveLength(2);
      expect(entries.reduce((sum, e) => sum + Number(e.amount), 0)).toBe(0);
      expect(entries.map((e) => [e.accountId, Number(e.amount)])).toEqual(
        expect.arrayContaining([
          [anaId, -30_000],
          [carlosId, 30_000],
        ]),
      );
      expect(await balanceOf(anaId)).toBe(70_000);
      expect(await balanceOf(carlosId)).toBe(30_000);
    });

    it('cada saldo es igual a la suma de sus asientos después de varias operaciones', async () => {
      await credit(anaId, 500_000);
      await transfer(120_000);
      await transfer(80_000);
      const back = await transfer(50_000, randomUUID(), carlosId, '10000000001');
      await ledger.reverse(back.id, { idempotencyKey: randomUUID(), reason: 'Prueba de reverso' });

      const report = await ledger.reconcile();
      expect(report.ok).toBe(true);
      expect(report.balanceMismatches).toEqual([]);
      expect(report.unbalancedTransactions).toEqual([]);
      const [{ total }] = await dataSource.query(
        'SELECT COALESCE(SUM(amount), 0)::float8 AS total FROM ledger_entries',
      );
      expect(total).toBe(0);
      expect(await balanceOf(anaId)).toBe(300_000);
      expect(await balanceOf(carlosId)).toBe(200_000);
    });

    it('la conciliación detecta un saldo que no coincide con sus asientos', async () => {
      await credit(anaId, 100_000);
      await dataSource.query('UPDATE ledger_balances SET balance = balance + 1 WHERE account_id = $1', [anaId]);
      const report = await ledger.reconcile();
      expect(report.ok).toBe(false);
      expect(report.balanceMismatches).toEqual([expect.objectContaining({ accountId: anaId })]);
    });

    it('las cuentas de sistema pueden quedar en negativo; las de clientes no', async () => {
      await credit(anaId, 10_000);
      await expect(transfer(10_001)).rejects.toBeInstanceOf(BadRequestException);
      expect(await balanceOf(anaId)).toBe(10_000);
      expect(await balanceOf('00000000-0000-4000-8000-000000000001')).toBe(-10_000);
    });
  });

  describe('idempotencia', () => {
    it('reenviar la misma clave devuelve la misma transacción y no mueve dinero dos veces', async () => {
      await credit(anaId, 100_000);
      const key = randomUUID();
      const first = await transfer(25_000, key);
      const second = await transfer(25_000, key);

      expect(second.id).toBe(first.id);
      expect(await count(LedgerTransaction)).toBe(2); // fondeo + transferencia
      expect(await balanceOf(anaId)).toBe(75_000);
      expect(await balanceOf(carlosId)).toBe(25_000);
    });

    it('la misma clave con otro monto es un conflicto (409) y no se registra', async () => {
      await credit(anaId, 100_000);
      const key = randomUUID();
      await transfer(25_000, key);
      await expect(transfer(26_000, key)).rejects.toBeInstanceOf(ConflictException);
      expect(await balanceOf(anaId)).toBe(75_000);
    });

    it('peticiones simultáneas con la misma clave crean una sola transacción', async () => {
      await credit(anaId, 100_000);
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => transfer(10_000, key)));

      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(await balanceOf(anaId)).toBe(90_000);
      expect(await count(LedgerEntry)).toBe(4);
    });

    it('un evento transaction.completed por titular y solo cuando se crea la transacción', async () => {
      await credit(anaId, 100_000);
      const key = randomUUID();
      await transfer(5_000, key);
      await transfer(5_000, key);
      // fondeo (1 evento: Ana) + transferencia (2: Ana sale, Carlos entra)
      expect(await count(LedgerOutbox)).toBe(3);
    });
  });

  describe('saldo y concurrencia', () => {
    it('transferencias simultáneas nunca dejan el saldo en negativo', async () => {
      await credit(anaId, 100_000);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => transfer(30_000)));
      const ok = results.filter((r) => r.status === 'fulfilled').length;

      expect(ok).toBe(3);
      expect(await balanceOf(anaId)).toBe(10_000);
      expect(await balanceOf(carlosId)).toBe(90_000);
      expect((await ledger.reconcile()).ok).toBe(true);
    });

    it('un rechazo no deja asientos ni eventos a medias', async () => {
      await credit(anaId, 1_000);
      const before = await count(LedgerEntry);
      await expect(transfer(5_000)).rejects.toThrow('Saldo insuficiente.');
      expect(await count(LedgerEntry)).toBe(before);
      expect(await count(LedgerOutbox)).toBe(1);
    });
  });

  describe('validaciones de la operación', () => {
    it('respeta el límite diario de la cuenta (403)', async () => {
      accounts.get(anaId)!.dailyLimit = 50_000;
      await credit(anaId, 200_000);
      await transfer(40_000);
      await expect(transfer(10_001)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(transfer(10_000)).resolves.toBeDefined();
    });

    it('no transfiere desde una cuenta ajena, inactiva o a la misma cuenta', async () => {
      await credit(anaId, 100_000);
      await expect(
        ledger.transfer(
          {
            sourceAccountId: anaId,
            destinationAccountNumber: '10000000002',
            amount: 1_000,
            idempotencyKey: randomUUID(),
          },
          CARLOS,
          CARLOS,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(transfer(1_000, randomUUID(), anaId, '10000000001')).rejects.toBeInstanceOf(BadRequestException);
      accounts.get(carlosId)!.status = 'blocked';
      await expect(transfer(1_000)).rejects.toThrow('La cuenta de destino no está activa.');
      expect(await balanceOf(anaId)).toBe(100_000);
    });
  });

  describe('reversos', () => {
    it('un reverso crea los asientos contrarios y no se puede repetir', async () => {
      await credit(anaId, 100_000);
      const tx = await transfer(40_000);
      const reversal = await ledger.reverse(tx.id, { idempotencyKey: randomUUID(), reason: 'Error del cliente' });

      expect(reversal.reversedTransactionId).toBe(tx.id);
      expect(await balanceOf(anaId)).toBe(100_000);
      expect(await balanceOf(carlosId)).toBe(0);
      await expect(ledger.reverse(tx.id, { idempotencyKey: randomUUID(), reason: 'Otra vez' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(
        ledger.reverse(reversal.id, { idempotencyKey: randomUUID(), reason: 'Reverso del reverso' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no reversa si quien recibió ya gastó el dinero', async () => {
      await credit(anaId, 100_000);
      const tx = await transfer(40_000);
      await transfer(35_000, randomUUID(), carlosId, '10000000001');
      await expect(ledger.reverse(tx.id, { idempotencyKey: randomUUID(), reason: 'Tarde' })).rejects.toThrow(
        'Saldo insuficiente.',
      );
    });
  });

  it('la cuenta de consignaciones de prueba no se usa fuera de su flujo', async () => {
    await credit(anaId, 1_000);
    expect(await balanceOf(DEMO_DEPOSIT_COP)).toBe(0);
  });
});
