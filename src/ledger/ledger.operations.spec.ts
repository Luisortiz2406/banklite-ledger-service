import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { account, ANA, CARLOS, createLedgerFixture, MERCHANT_OWNER, SYSTEM } from '../testing/ledger-fixture';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerOutbox } from './entities/ledger-outbox.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';

/**
 * Operaciones del ledger que mueven dinero (cargos, pagos, canjes, ahorro, abonos
 * del panel, consignaciones de prueba y reversos), contra PostgreSQL real. Lo más
 * importante en cada una: saldo insuficiente, idempotencia y que un rechazo no
 * deje asientos ni eventos a medias.
 */
describeWithDb('LedgerService: operaciones que mueven dinero', () => {
  let fx: Awaited<ReturnType<typeof createLedgerFixture>>;
  let anaId: string;
  let carlosId: string;
  let tiendaId: string;

  beforeAll(async () => {
    fx = await createLedgerFixture();
  });
  afterAll(() => fx?.drop());

  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    fx.config.set('ENABLE_DEMO_DEPOSITS', undefined);
    fx.config.set('NODE_ENV', 'test');
    anaId = randomUUID();
    carlosId = randomUUID();
    tiendaId = randomUUID();
    fx.accounts.clear();
    fx.accounts.set(anaId, account(anaId, '10000000001', ANA));
    fx.accounts.set(carlosId, account(carlosId, '10000000002', CARLOS));
    fx.accounts.set(tiendaId, account(tiendaId, '30000000001', MERCHANT_OWNER, { accountType: 'merchant' }));
  });

  const { balanceOf, entriesOf, count } = {
    balanceOf: (id: string) => fx.balanceOf(id),
    entriesOf: (id: string) => fx.entriesOf(id),
    count: (entity: typeof LedgerTransaction | typeof LedgerEntry | typeof LedgerOutbox) => fx.count(entity),
  };
  const fund = (accountId: string, amount: number) =>
    fx.ledger.credit({ accountId, amount, idempotencyKey: randomUUID(), description: 'Fondeo de prueba' });
  const events = () => fx.dataSource.getRepository(LedgerOutbox).find({ order: { createdAt: 'ASC' } });
  const sumOf = async (transactionId: string) =>
    (await entriesOf(transactionId)).reduce((sum, entry) => sum + Number(entry.amount), 0);
  /** Nada quedó a medias: ni transacciones, ni asientos, ni eventos. */
  const nothingRecorded = async () => {
    expect(await count(LedgerTransaction)).toBe(0);
    expect(await count(LedgerEntry)).toBe(0);
    expect(await count(LedgerOutbox)).toBe(0);
  };

  describe('abono externo (credit)', () => {
    it('abona contra la cuenta de compensación con doble partida y un evento de entrada', async () => {
      const tx = await fund(anaId, 75_000);

      expect(tx).toMatchObject({ type: 'credit', sourceAccountId: SYSTEM.clearing, destinationAccountId: anaId });
      expect(await balanceOf(anaId)).toBe(75_000);
      expect(await balanceOf(SYSTEM.clearing)).toBe(-75_000);
      expect(await sumOf(tx.id)).toBe(0);
      expect((await events()).map((e) => e.payload)).toEqual([
        expect.objectContaining({ idUser: ANA, direction: 'in', amount: 75_000 }),
      ]);
    });

    it('no abona a una cuenta inactiva, y la misma clave con otro monto es un conflicto', async () => {
      const bloqueada = randomUUID();
      fx.accounts.set(bloqueada, account(bloqueada, '10000000009', ANA, { status: 'blocked' }));
      await expect(fund(bloqueada, 1_000)).rejects.toBeInstanceOf(BadRequestException);
      await nothingRecorded();

      const key = randomUUID();
      await fx.ledger.credit({ accountId: anaId, amount: 1_000, idempotencyKey: key });
      const again = await fx.ledger.credit({ accountId: anaId, amount: 1_000, idempotencyKey: key });
      expect(again.description).toBe('Abono');
      await expect(fx.ledger.credit({ accountId: anaId, amount: 2_000, idempotencyKey: key })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await balanceOf(anaId)).toBe(1_000);
    });

    it('rechaza una moneda sin cuenta de compensación', async () => {
      const euros = randomUUID();
      fx.accounts.set(euros, account(euros, '10000000008', ANA, { currency: 'EUR' }));
      await expect(fund(euros, 1_000)).rejects.toThrow('Moneda no soportada: EUR');
    });
  });

  describe('cargo interno (debit)', () => {
    const debit = (accountId: string, amount: number, idempotencyKey = randomUUID(), description?: string) =>
      fx.ledger.debit({ accountId, amount, idempotencyKey, description });

    it('descuenta del cliente hacia compensación y avisa con un evento de salida', async () => {
      await fund(anaId, 100_000);
      const tx = await debit(anaId, 40_000, randomUUID(), 'Compra con tarjeta');

      expect(tx).toMatchObject({ type: 'debit', userId: ANA, description: 'Compra con tarjeta' });
      expect(await balanceOf(anaId)).toBe(60_000);
      expect(await balanceOf(SYSTEM.clearing)).toBe(-60_000);
      expect(await sumOf(tx.id)).toBe(0);
      expect((await events()).at(-1)?.payload).toMatchObject({ idUser: ANA, direction: 'out', amount: 40_000 });
    });

    it('saldo insuficiente: rechaza y no deja asientos ni eventos de esa operación', async () => {
      await fund(anaId, 10_000);
      const antes = [await count(LedgerTransaction), await count(LedgerEntry), await count(LedgerOutbox)];

      await expect(debit(anaId, 10_000.01)).rejects.toThrow('Saldo insuficiente');

      expect([await count(LedgerTransaction), await count(LedgerEntry), await count(LedgerOutbox)]).toEqual(antes);
      expect(await balanceOf(anaId)).toBe(10_000);
    });

    it('puede gastar exactamente todo el saldo', async () => {
      await fund(anaId, 10_000);
      await debit(anaId, 10_000);
      expect(await balanceOf(anaId)).toBe(0);
    });

    it('la misma clave devuelve el mismo cargo sin cobrar dos veces; con otro monto da 409', async () => {
      await fund(anaId, 100_000);
      const key = randomUUID();
      const first = await debit(anaId, 30_000, key);
      const again = await debit(anaId, 30_000, key);

      expect(again.id).toBe(first.id);
      expect(await balanceOf(anaId)).toBe(70_000);
      await expect(debit(anaId, 31_000, key)).rejects.toBeInstanceOf(ConflictException);
      expect(await balanceOf(anaId)).toBe(70_000);
    });

    it('respeta los límites diario y mensual de la cuenta (403)', async () => {
      accountsFor(anaId, { dailyLimit: 50_000, monthlyLimit: 120_000 });
      await fund(anaId, 1_000_000);
      await debit(anaId, 30_000);
      await expect(debit(anaId, 30_000)).rejects.toThrow('límite diario');

      accountsFor(anaId, { dailyLimit: 1_000_000, monthlyLimit: 40_000 });
      await expect(debit(anaId, 20_000)).rejects.toThrow('límite mensual');
      expect(await balanceOf(anaId)).toBe(970_000);
    });

    it('un reverso devuelve el dinero y no consume el cupo', async () => {
      accountsFor(anaId, { dailyLimit: 50_000, monthlyLimit: 500_000 });
      await fund(anaId, 500_000);
      const cargo = await debit(anaId, 40_000);
      await fx.ledger.reverse(cargo.id, { idempotencyKey: randomUUID(), reason: 'Compra anulada' });

      expect(await balanceOf(anaId)).toBe(500_000);
      // El cupo diario sigue en 40.000 gastados (el reverso no suma ni resta): 40.000 + 10.000 cabe.
      await expect(debit(anaId, 10_000)).resolves.toBeDefined();
      await expect(debit(anaId, 1_000)).rejects.toThrow('límite diario');
    });

    it('rechaza una cuenta inexistente o inactiva', async () => {
      await expect(debit(randomUUID(), 1_000)).rejects.toBeInstanceOf(NotFoundException);
      accountsFor(anaId, { status: 'blocked' });
      await expect(debit(anaId, 1_000)).rejects.toBeInstanceOf(BadRequestException);
      await nothingRecorded();
    });
  });

  function accountsFor(id: string, changes: Partial<ReturnType<typeof account>>) {
    fx.accounts.set(id, { ...fx.accounts.get(id)!, ...changes });
  }

  describe('pago a comercio (payment)', () => {
    const pay = (overrides: Partial<Parameters<typeof fx.ledger.payment>[0]> = {}) =>
      fx.ledger.payment({
        sourceAccountId: anaId,
        merchantAccountId: tiendaId,
        amount: 25_000,
        idempotencyKey: randomUUID(),
        ...overrides,
      });

    it('mueve el dinero del cliente al comercio y solo el cliente recibe el evento', async () => {
      await fund(anaId, 100_000);
      const tx = await pay({ description: 'Suscripción mensual' });

      expect(tx).toMatchObject({ type: 'payment', description: 'Suscripción mensual' });
      expect(await balanceOf(anaId)).toBe(75_000);
      expect(await balanceOf(tiendaId)).toBe(25_000);
      expect(await sumOf(tx.id)).toBe(0);
      const payments = (await events()).filter((e) => e.payload.type === 'payment');
      expect(payments).toHaveLength(1);
      expect(payments[0].payload).toMatchObject({ idUser: ANA, direction: 'out' });
    });

    it('saldo insuficiente: no paga ni deja nada a medias', async () => {
      await fund(anaId, 20_000);
      await expect(pay()).rejects.toThrow('Saldo insuficiente');
      expect(await balanceOf(anaId)).toBe(20_000);
      expect(await balanceOf(tiendaId)).toBe(0);
      expect(await count(LedgerTransaction)).toBe(1); // solo el fondeo
    });

    it('el mismo cobro (misma clave) no se registra dos veces', async () => {
      await fund(anaId, 100_000);
      const key = randomUUID();
      const first = await pay({ idempotencyKey: key });
      const again = await pay({ idempotencyKey: key });

      expect(again.id).toBe(first.id);
      expect(await balanceOf(anaId)).toBe(75_000);
      await expect(pay({ idempotencyKey: key, amount: 26_000 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('valida los tipos de cuenta, el estado y la moneda', async () => {
      await fund(anaId, 100_000);
      await expect(pay({ sourceAccountId: tiendaId, merchantAccountId: tiendaId })).rejects.toThrow(
        'no puede ser de un comercio',
      );
      await expect(pay({ merchantAccountId: carlosId })).rejects.toThrow('no es de un comercio');
      accountsFor(tiendaId, { status: 'blocked' });
      await expect(pay()).rejects.toThrow('comercio no está activa');
      accountsFor(tiendaId, { status: 'active', currency: 'USD' });
      await expect(pay()).rejects.toThrow('misma moneda');
      accountsFor(anaId, { status: 'blocked' });
      await expect(pay()).rejects.toThrow('origen no está activa');
      expect(await balanceOf(anaId)).toBe(100_000);
    });

    it('respeta el límite diario del cliente', async () => {
      accountsFor(anaId, { dailyLimit: 30_000 });
      await fund(anaId, 100_000);
      await pay({ amount: 20_000 });
      await expect(pay({ amount: 20_000 })).rejects.toThrow('límite diario');
    });
  });

  describe('canje de puntos (reward)', () => {
    const reward = (overrides: Partial<Parameters<typeof fx.ledger.reward>[0]> = {}) =>
      fx.ledger.reward({
        target: 'account',
        accountId: anaId,
        beneficiaryUserId: ANA,
        amount: 5_000,
        idempotencyKey: randomUUID(),
        ...overrides,
      });

    it('a la cuenta del cliente: sale de Recompensas, entra al saldo y avisa con un evento', async () => {
      const tx = await reward();

      expect(tx).toMatchObject({ type: 'reward', userId: ANA, description: 'Canje de Puntos Banklite' });
      expect(await balanceOf(anaId)).toBe(5_000);
      expect(await balanceOf(SYSTEM.rewards)).toBe(-5_000);
      expect((await events()).map((e) => e.payload)).toEqual([
        expect.objectContaining({ idUser: ANA, direction: 'in', type: 'reward' }),
      ]);
    });

    it('a un comercio: paga en nombre del cliente y no genera evento del cliente', async () => {
      await reward({ target: 'merchant', accountId: tiendaId, amount: 8_000 });

      expect(await balanceOf(tiendaId)).toBe(8_000);
      expect(await balanceOf(anaId)).toBe(0);
      expect(await count(LedgerOutbox)).toBe(0);
    });

    it('rechaza una cuenta que no corresponde al destino o al cliente', async () => {
      await expect(reward({ target: 'merchant', accountId: anaId })).rejects.toThrow('no es de un comercio');
      await expect(reward({ accountId: tiendaId })).rejects.toThrow('es de un comercio');
      await expect(reward({ beneficiaryUserId: CARLOS })).rejects.toThrow('no es del cliente');
      accountsFor(anaId, { status: 'blocked' });
      await expect(reward()).rejects.toBeInstanceOf(BadRequestException);
      await nothingRecorded();
    });

    it('el mismo canje (misma clave) no se paga dos veces', async () => {
      const key = randomUUID();
      await reward({ idempotencyKey: key });
      await reward({ idempotencyKey: key });
      expect(await balanceOf(anaId)).toBe(5_000);
      await expect(reward({ idempotencyKey: key, amount: 6_000 })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('ahorro (savings)', () => {
    const save = (overrides: Partial<Parameters<typeof fx.ledger.savings>[0]> = {}) =>
      fx.ledger.savings({
        kind: 'to_custody',
        product: 'pocket',
        accountId: anaId,
        beneficiaryUserId: ANA,
        amount: 20_000,
        idempotencyKey: randomUUID(),
        ...overrides,
      });

    it('apartar mueve el dinero a la custodia del bolsillo o del CDT, sin eventos', async () => {
      await fund(anaId, 100_000);
      const eventosAntes = await count(LedgerOutbox);
      await save();
      await save({ product: 'cdt', amount: 30_000 });

      expect(await balanceOf(anaId)).toBe(50_000);
      expect(await balanceOf(SYSTEM.pocketCustody)).toBe(20_000);
      expect(await balanceOf(SYSTEM.cdtCustody)).toBe(30_000);
      expect(await count(LedgerOutbox)).toBe(eventosAntes);
    });

    it('apartar sin saldo suficiente se rechaza; sacar de la custodia no pide saldo del cliente', async () => {
      await fund(anaId, 10_000);
      await expect(save({ amount: 10_000.01 })).rejects.toThrow('Saldo insuficiente');
      expect(await balanceOf(anaId)).toBe(10_000);

      await save({ amount: 10_000 });
      await save({ kind: 'from_custody', amount: 4_000 });
      expect(await balanceOf(anaId)).toBe(4_000);
      expect(await balanceOf(SYSTEM.pocketCustody)).toBe(6_000);
    });

    it('los intereses salen de la cuenta Intereses pagados, hacia la custodia o hacia la cuenta', async () => {
      await save({ kind: 'interest_to_custody', amount: 1_500 });
      await save({ kind: 'interest_to_account', product: 'cdt', amount: 2_500 });

      expect(await balanceOf(SYSTEM.interest)).toBe(-4_000);
      expect(await balanceOf(SYSTEM.pocketCustody)).toBe(1_500);
      expect(await balanceOf(anaId)).toBe(2_500);
    });

    it('rechaza una cuenta ajena, de comercio o inactiva', async () => {
      await expect(save({ beneficiaryUserId: CARLOS })).rejects.toThrow('no es del cliente');
      await expect(save({ accountId: tiendaId, beneficiaryUserId: MERCHANT_OWNER })).rejects.toThrow(
        'no es del cliente',
      );
      accountsFor(anaId, { status: 'blocked' });
      await expect(save()).rejects.toThrow('ahorro no está activa');
      await nothingRecorded();
    });

    it('la misma clave no aparta dos veces', async () => {
      await fund(anaId, 100_000);
      const key = randomUUID();
      await save({ idempotencyKey: key });
      await save({ idempotencyKey: key });
      expect(await balanceOf(anaId)).toBe(80_000);
      await expect(save({ idempotencyKey: key, amount: 21_000 })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('abono del panel (adminCredit)', () => {
    const adminCredit = (overrides: Partial<Parameters<typeof fx.ledger.adminCredit>[0]> = {}) =>
      fx.ledger.adminCredit({
        accountNumber: '10000000001',
        amount: 50_000,
        reason: ' Ajuste por error del banco ',
        idempotencyKey: randomUUID(),
        ...overrides,
      });

    it('abona contra Abonos administrativos y deja el motivo en la descripción', async () => {
      const { transaction, account: destino } = await adminCredit();

      expect(destino.id).toBe(anaId);
      expect(transaction.description).toBe('Abono BankLite: Ajuste por error del banco');
      expect(await balanceOf(anaId)).toBe(50_000);
      expect(await balanceOf(SYSTEM.adminCredit)).toBe(-50_000);
      expect(await sumOf(transaction.id)).toBe(0);
    });

    it('no pasa del máximo (por defecto 10.000.000, configurable) ni va a comercios o cuentas inactivas', async () => {
      await expect(adminCredit({ amount: 10_000_001 })).rejects.toThrow('no puede superar 10000000');
      fx.config.set('ADMIN_CREDIT_MAX_AMOUNT', '20000');
      await expect(adminCredit({ amount: 20_001 })).rejects.toThrow('no puede superar 20000');
      await expect(adminCredit({ amount: 20_000 })).resolves.toBeDefined();
      fx.config.set('ADMIN_CREDIT_MAX_AMOUNT', undefined);

      await expect(adminCredit({ accountNumber: '30000000001' })).rejects.toThrow('cuentas de comercio');
      accountsFor(carlosId, { status: 'blocked' });
      await expect(adminCredit({ accountNumber: '10000000002' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(adminCredit({ accountNumber: '99999999999' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reenviar el formulario (misma clave) no abona dos veces', async () => {
      const key = randomUUID();
      const first = await adminCredit({ idempotencyKey: key });
      const again = await adminCredit({ idempotencyKey: key });

      expect(again.transaction.id).toBe(first.transaction.id);
      expect(await balanceOf(anaId)).toBe(50_000);
      await expect(adminCredit({ idempotencyKey: key, amount: 60_000 })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('consignación de prueba (deposit)', () => {
    const deposit = (amount = 100_000, key = randomUUID(), accountId = anaId, token = ANA) =>
      fx.ledger.deposit(accountId, { amount, idempotencyKey: key }, token, token);

    it('por defecto está deshabilitada, y en producción nunca se permite', async () => {
      expect(fx.ledger.getDemoDepositsConfig()).toEqual({ enabled: false, maxAmount: 5_000_000 });
      await expect(deposit()).rejects.toThrow('no están habilitadas');

      fx.config.set('ENABLE_DEMO_DEPOSITS', 'true');
      fx.config.set('NODE_ENV', 'production');
      expect(fx.ledger.getDemoDepositsConfig().enabled).toBe(false);
      await expect(deposit()).rejects.toBeInstanceOf(ForbiddenException);
      await nothingRecorded();
    });

    it('habilitada, el titular se consigna a su propia cuenta contra la cuenta de consignaciones', async () => {
      fx.config.set('ENABLE_DEMO_DEPOSITS', 'true');
      expect(fx.ledger.getDemoDepositsConfig().enabled).toBe(true);
      const tx = await deposit(250_000);

      expect(tx).toMatchObject({ type: 'deposit', description: 'Consignación de prueba' });
      expect(await balanceOf(anaId)).toBe(250_000);
      expect(await balanceOf(SYSTEM.demoDeposit)).toBe(-250_000);
      expect((await events()).at(-1)?.payload).toMatchObject({ idUser: ANA, direction: 'in' });
    });

    it('respeta el máximo, la titularidad y el estado de la cuenta', async () => {
      fx.config.set('ENABLE_DEMO_DEPOSITS', 'true');
      await expect(deposit(5_000_001)).rejects.toThrow('no puede superar 5000000');
      fx.config.set('DEMO_DEPOSIT_MAX_AMOUNT', '1000');
      expect(fx.ledger.getDemoDepositsConfig().maxAmount).toBe(1_000);
      await expect(deposit(1_001)).rejects.toThrow('no puede superar 1000');
      fx.config.set('DEMO_DEPOSIT_MAX_AMOUNT', undefined);

      await expect(deposit(1_000, randomUUID(), carlosId, ANA)).rejects.toBeInstanceOf(ForbiddenException);
      accountsFor(anaId, { status: 'blocked' });
      await expect(deposit(1_000)).rejects.toBeInstanceOf(BadRequestException);
      await nothingRecorded();
    });

    it('la misma clave no consigna dos veces', async () => {
      fx.config.set('ENABLE_DEMO_DEPOSITS', 'true');
      const key = randomUUID();
      await deposit(10_000, key);
      await deposit(10_000, key);
      expect(await balanceOf(anaId)).toBe(10_000);
      await expect(deposit(20_000, key)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reversos', () => {
    const reverse = (id: string, reason = 'Error operativo') =>
      fx.ledger.reverse(id, { idempotencyKey: randomUUID(), reason });

    it('reversar un pago a comercio devuelve el dinero y avisa solo al cliente', async () => {
      await fund(anaId, 100_000);
      const pago = await fx.ledger.payment({
        sourceAccountId: anaId,
        merchantAccountId: tiendaId,
        amount: 30_000,
        idempotencyKey: randomUUID(),
      });
      const reverso = await reverse(pago.id, 'Cobro duplicado');

      expect(reverso).toMatchObject({ type: 'reversal', reversedTransactionId: pago.id });
      expect(reverso.description).toBe('Reverso: Cobro duplicado');
      expect(await balanceOf(anaId)).toBe(100_000);
      expect(await balanceOf(tiendaId)).toBe(0);
      const avisos = (await events()).filter((e) => e.payload.type === 'reversal');
      expect(avisos.map((e) => e.payload)).toEqual([expect.objectContaining({ idUser: ANA, direction: 'in' })]);
    });

    it('un reverso no se puede reversar y una transacción inexistente da 404', async () => {
      await fund(anaId, 10_000);
      const cargo = await fx.ledger.debit({ accountId: anaId, amount: 1_000, idempotencyKey: randomUUID() });
      const reverso = await reverse(cargo.id);

      await expect(reverse(reverso.id)).rejects.toThrow('no se puede reversar');
      await expect(reverse(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('consultas del cliente', () => {
    it('el saldo solo lo ve el titular', async () => {
      await fund(anaId, 12_000);
      expect(await fx.ledger.getBalance(anaId, ANA)).toEqual({ accountId: anaId, currency: 'COP', balance: 12_000 });
      expect(await fx.ledger.getBalance(carlosId, CARLOS)).toMatchObject({ balance: 0 });
      await expect(fx.ledger.getBalance(anaId, CARLOS)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('los movimientos salen del más reciente al más antiguo, paginados, con los últimos 4 dígitos de la contraparte', async () => {
      await fund(anaId, 100_000);
      await fx.ledger.transfer(
        {
          sourceAccountId: anaId,
          destinationAccountNumber: '10000000002',
          amount: 10_000,
          idempotencyKey: randomUUID(),
        },
        ANA,
        ANA,
      );
      await fx.ledger.debit({ accountId: anaId, amount: 5_000, idempotencyKey: randomUUID(), description: 'Café' });

      const todos = await fx.ledger.getTransactions(anaId, ANA, {});
      expect(todos.map((m) => [m.type, m.direction, m.amount])).toEqual([
        ['debit', 'out', 5_000],
        ['transfer', 'out', 10_000],
        ['credit', 'in', 100_000],
      ]);
      expect(todos[1].counterpartyAccountLast4).toBe('0002');
      expect(todos[2].counterpartyAccountLast4).toBeNull();

      const segunda = await fx.ledger.getTransactions(anaId, ANA, { page: 2, limit: 2 });
      expect(segunda.map((m) => m.type)).toEqual(['credit']);
      expect(await fx.ledger.getTransactions(carlosId, CARLOS, { page: 3 })).toEqual([]);
      await expect(fx.ledger.getTransactions(anaId, CARLOS, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('filtra por fechas y exige que la inicial sea anterior a la final', async () => {
      await fund(anaId, 1_000);
      const ayer = new Date(Date.now() - 86_400_000).toISOString();
      const manana = new Date(Date.now() + 86_400_000).toISOString();

      expect(await fx.ledger.getTransactions(anaId, ANA, { from: ayer, to: manana })).toHaveLength(1);
      expect(await fx.ledger.getTransactions(anaId, ANA, { from: ayer })).toHaveLength(1);
      expect(await fx.ledger.getTransactions(anaId, ANA, { to: manana })).toHaveLength(1);
      expect(await fx.ledger.getTransactions(anaId, ANA, { from: manana })).toHaveLength(0);
      expect(await fx.ledger.getTransactions(anaId, ANA, { to: ayer })).toHaveLength(0);
      await expect(fx.ledger.getTransactions(anaId, ANA, { from: manana, to: ayer })).rejects.toThrow(
        'fecha inicial debe ser anterior',
      );
    });

    it('el extracto trae saldo inicial, entradas, salidas y saldo final del periodo', async () => {
      await fund(anaId, 100_000);
      // Ese abono ocurrió hace 10 días: queda fuera del periodo y cuenta como saldo inicial.
      await fx.dataSource.query(`UPDATE ledger_entries SET created_at = now() - interval '10 days'`);
      await fx.ledger.debit({ accountId: anaId, amount: 15_000, idempotencyKey: randomUUID() });
      await fund(anaId, 5_000);

      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const extracto = await fx.ledger.getStatement(anaId, ANA, { from, to });

      expect(extracto).toMatchObject({
        accountNumber: '10000000001',
        currency: 'COP',
        openingBalance: 100_000,
        totalIn: 5_000,
        totalOut: 15_000,
        closingBalance: 90_000,
        movementCount: 2,
        truncated: false,
      });
      expect(extracto.movements.map((m) => m.type)).toEqual(['debit', 'credit']);
    });

    it('el extracto rechaza periodos al revés o de más de 366 días, y cuentas ajenas', async () => {
      const ahora = Date.now();
      const iso = (offsetDays: number) => new Date(ahora + offsetDays * 86_400_000).toISOString();
      await expect(fx.ledger.getStatement(anaId, ANA, { from: iso(1), to: iso(-1) })).rejects.toThrow(
        'fecha inicial debe ser anterior',
      );
      await expect(fx.ledger.getStatement(anaId, ANA, { from: iso(-400), to: iso(0) })).rejects.toThrow(
        'máximo 366 días',
      );
      await expect(fx.ledger.getStatement(anaId, CARLOS, { from: iso(-1), to: iso(0) })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('cuadre (reconcile)', () => {
    it('con todo en orden dice ok, lista las cuentas del sistema y cuenta los eventos sin publicar', async () => {
      await fund(anaId, 40_000);
      await fx.ledger.debit({ accountId: anaId, amount: 10_000, idempotencyKey: randomUUID() });

      const cuadre = await fx.ledger.reconcile();

      expect(cuadre).toMatchObject({
        ok: true,
        balanceMismatches: [],
        orphanEntries: [],
        unbalancedTransactions: [],
        pendingEvents: { count: 2 },
      });
      expect(cuadre.systemAccounts).toEqual([
        expect.objectContaining({ accountId: SYSTEM.clearing, name: 'Compensación COP', balance: -30_000 }),
      ]);
    });

    it('detecta asientos sin saldo y transacciones que no suman cero', async () => {
      await fund(anaId, 40_000);
      await fx.dataSource.getRepository(LedgerBalance).delete({ accountId: anaId });
      await fx.dataSource.query(`UPDATE ledger_entries SET amount = amount + 1 WHERE account_id = $1`, [anaId]);

      const cuadre = await fx.ledger.reconcile();

      expect(cuadre.ok).toBe(false);
      expect(cuadre.orphanEntries).toEqual([expect.objectContaining({ accountId: anaId })]);
      expect(cuadre.unbalancedTransactions).toHaveLength(1);
    });
  });
});
