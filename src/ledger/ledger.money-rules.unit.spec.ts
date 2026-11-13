import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LedgerAccountInfo } from './accounts-client.service';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { LedgerService } from './ledger.service';

/**
 * Prueba UNITARIA y aislada de la lógica de dinero de LedgerService: la base de datos (DataSource y su
 * administrador de transacción), el cliente de account-service y el outbox de eventos son mocks, así que no
 * hay Postgres, red ni bus. Lo que se comprueba es la regla de negocio: doble partida que suma cero, saldo
 * suficiente, límites, idempotencia, reversos y reintento de los conflictos de concurrencia. (Las
 * transacciones SERIALIZABLE y los bloqueos reales se prueban aparte, contra Postgres, en
 * ledger.operations.spec.ts y ledger.service.spec.ts.)
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const ORIGEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DESTINO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAVE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN = 'token-de-acceso';

const cuenta = (over: Partial<LedgerAccountInfo> = {}): LedgerAccountInfo => ({
  id: ORIGEN,
  accountNumber: '10000000001',
  accountType: 'savings',
  idUser: ANA,
  currency: 'COP',
  status: 'active',
  ...over,
});
const cuentaDestino = (over: Partial<LedgerAccountInfo> = {}) =>
  cuenta({ id: DESTINO, accountNumber: '10000000002', idUser: CARLOS, ...over });

function armar() {
  const saldos = new Map<string, string>([
    [ORIGEN, '100000.00'],
    [DESTINO, '0.00'],
  ]);
  /** Lo gastado que devolvería la base: primero el del día y luego el del mes (así los pide el servicio). */
  const gastado: string[] = [];
  let existente: Partial<LedgerTransaction> | null = null;
  let yaReversada: Partial<LedgerTransaction> | null = null;

  const manager = {
    findOne: jest.fn(async (_entidad: unknown, { where }: { where: Record<string, unknown> }) =>
      'idempotencyKey' in where ? existente : 'reversedTransactionId' in where ? yaReversada : null,
    ),
    create: jest.fn((_entidad: unknown, datos: object) => ({
      id: 'tx-nueva',
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
      ...datos,
    })),
    save: jest.fn(async (..._args: unknown[]) => undefined),
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.startsWith('INSERT INTO ledger_balances')) {
        if (!saldos.has(params[0] as string)) saldos.set(params[0] as string, '0.00');
        return [];
      }
      if (sql.includes('FROM ledger_balances')) {
        return (params[0] as string[]).map((id) => ({ account_id: id, currency: 'COP', balance: saldos.get(id) }));
      }
      if (sql.includes('FROM ledger_entries')) return [{ total: gastado.shift() ?? '0' }];
      return []; // UPDATE ledger_balances
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (_nivel: string, trabajo: (m: typeof manager) => unknown) => trabajo(manager)),
  };
  const cuentas = {
    getOwnedAccount: jest.fn().mockResolvedValue(cuenta()),
    getInternalAccountByNumber: jest.fn().mockResolvedValue(cuentaDestino()),
    getInternalAccount: jest.fn(async (id: string) => (id === ORIGEN ? cuenta() : cuentaDestino())),
    getLimits: jest.fn().mockResolvedValue({ dailyLimit: 5_000_000, monthlyLimit: 50_000_000 }),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined), flush: jest.fn().mockResolvedValue(undefined) };
  const transacciones = { findOne: jest.fn() };
  const ledger = new LedgerService(
    dataSource as never,
    {} as never,
    {} as never,
    transacciones as never,
    cuentas as never,
    outbox as never,
    new ConfigService({}),
  );

  return {
    ledger,
    manager,
    dataSource,
    cuentas,
    outbox,
    transacciones,
    saldos,
    gastado,
    yaExiste: (transaccion: Partial<LedgerTransaction>) => (existente = transaccion),
    yaFueReversada: (transaccion: Partial<LedgerTransaction>) => (yaReversada = transaccion),
    /** Todo lo que se escribió en la base: transacciones, asientos, saldos y eventos. */
    escrituras: () =>
      manager.save.mock.calls.length +
      manager.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE')).length +
      outbox.enqueue.mock.calls.length,
  };
}

const transferencia = (over: Record<string, unknown> = {}) => ({
  sourceAccountId: ORIGEN,
  destinationAccountNumber: '10000000002',
  amount: 50_000,
  description: 'Arriendo',
  idempotencyKey: CLAVE,
  ...over,
});

describe('LedgerService: reglas de dinero, aisladas con mocks', () => {
  describe('transferencia', () => {
    it('registra la doble partida que suma cero, mueve los dos saldos y avisa a quien envía y a quien recibe', async () => {
      const t = armar();

      const resultado = await t.ledger.transfer(transferencia(), ANA, TOKEN);

      expect(resultado).toMatchObject({
        id: 'tx-nueva',
        type: 'transfer',
        sourceAccountId: ORIGEN,
        destinationAccountId: DESTINO,
        amount: '50000.00',
        description: 'Arriendo',
      });
      // Corre en una transacción SERIALIZABLE
      expect(t.dataSource.transaction).toHaveBeenCalledWith('SERIALIZABLE', expect.any(Function));
      // Dos asientos: sale de origen y entra a destino, por el mismo monto
      const [entidad, asientos] = t.manager.save.mock.calls.find(([primero]) => primero === LedgerEntry) as unknown as [
        unknown,
        { accountId: string; amount: string }[],
      ];
      expect(entidad).toBe(LedgerEntry);
      expect(asientos.map((a) => [a.accountId, a.amount])).toEqual([
        [ORIGEN, '-50000.00'],
        [DESTINO, '50000.00'],
      ]);
      expect(asientos.reduce((suma, a) => suma + Number(a.amount), 0)).toBe(0);
      // Saldos: resta al origen y suma al destino
      const actualizaciones = t.manager.query.mock.calls.filter(([sql]) =>
        String(sql).startsWith('UPDATE ledger_balances'),
      );
      expect(
        actualizaciones.map(([sql, params]) => [String(sql).includes('balance - ') ? 'resta' : 'suma', params]),
      ).toEqual([
        ['resta', ['50000.00', ORIGEN]],
        ['suma', ['50000.00', DESTINO]],
      ]);
      // Un evento por titular y publicación inmediata una vez guardado
      const [, evento, eventos] = t.outbox.enqueue.mock.calls[0];
      expect(evento).toBe('transaction.completed');
      expect(eventos.map((e: any) => [e.idUser, e.direction, e.amount])).toEqual([
        [ANA, 'out', 50_000],
        [CARLOS, 'in', 50_000],
      ]);
      expect(t.outbox.flush).toHaveBeenCalledTimes(1);
    });

    it('entre dos cuentas del mismo titular se avisa una sola vez', async () => {
      const t = armar();
      t.cuentas.getInternalAccountByNumber.mockResolvedValue(cuentaDestino({ idUser: ANA }));

      await t.ledger.transfer(transferencia(), ANA, TOKEN);

      const eventos = t.outbox.enqueue.mock.calls[0][2];
      expect(eventos.map((e: any) => [e.idUser, e.direction])).toEqual([[ANA, 'out']]);
    });

    it('sin saldo suficiente responde 400 y no escribe nada: ni transacción, ni asientos, ni saldos, ni eventos', async () => {
      const t = armar();
      t.saldos.set(ORIGEN, '49999.99');

      await expect(t.ledger.transfer(transferencia(), ANA, TOKEN)).rejects.toThrow(
        new BadRequestException('Saldo insuficiente.'),
      );

      expect(t.escrituras()).toBe(0);
      expect(t.outbox.flush).not.toHaveBeenCalled();
    });

    it('con el saldo justo sí pasa (el saldo puede quedar en cero, no por debajo)', async () => {
      const t = armar();
      t.saldos.set(ORIGEN, '50000.00');

      await expect(t.ledger.transfer(transferencia(), ANA, TOKEN)).resolves.toMatchObject({ amount: '50000.00' });
    });

    it('supera el límite diario o el mensual: 403 sin escribir nada; justo en el límite sí pasa', async () => {
      const diario = armar();
      diario.gastado.push('4950000', '4950000');
      await expect(diario.ledger.transfer(transferencia({ amount: 50_001 }), ANA, TOKEN)).rejects.toThrow(
        new ForbiddenException('La operación supera el límite diario de la cuenta.'),
      );
      expect(diario.escrituras()).toBe(0);

      const mensual = armar();
      mensual.gastado.push('0', '49990000');
      await expect(mensual.ledger.transfer(transferencia({ amount: 10_001 }), ANA, TOKEN)).rejects.toThrow(
        new ForbiddenException('La operación supera el límite mensual de la cuenta.'),
      );
      expect(mensual.escrituras()).toBe(0);

      const justo = armar();
      justo.gastado.push('4950000', '4950000');
      await expect(justo.ledger.transfer(transferencia({ amount: 50_000 }), ANA, TOKEN)).resolves.toBeDefined();
    });

    it.each([
      ['a la misma cuenta', () => ({ destino: cuenta() }), 'diferente a la cuenta de origen'],
      ['con la cuenta de origen inactiva', () => ({ origen: cuenta({ status: 'blocked' }) }), 'origen no está activa'],
      [
        'con la cuenta destino inactiva',
        () => ({ destino: cuentaDestino({ status: 'closed' }) }),
        'destino no está activa',
      ],
      [
        'a una cuenta de comercio',
        () => ({ destino: cuentaDestino({ accountType: 'merchant' }) }),
        'es de un comercio',
      ],
      ['entre monedas distintas', () => ({ destino: cuentaDestino({ currency: 'USD' }) }), 'misma moneda'],
    ])('no se transfiere %s: 400 antes de abrir la transacción', async (_caso, cambios, mensaje) => {
      const t = armar();
      const { origen, destino } = cambios() as { origen?: LedgerAccountInfo; destino?: LedgerAccountInfo };
      if (origen) t.cuentas.getOwnedAccount.mockResolvedValue(origen);
      if (destino) t.cuentas.getInternalAccountByNumber.mockResolvedValue(destino);

      await expect(t.ledger.transfer(transferencia(), ANA, TOKEN)).rejects.toThrow(mensaje);

      expect(t.dataSource.transaction).not.toHaveBeenCalled();
      expect(t.cuentas.getLimits).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia', () => {
    const yaRegistrada = {
      id: 'tx-vieja',
      type: 'transfer' as const,
      userId: ANA,
      sourceAccountId: ORIGEN,
      destinationAccountId: DESTINO,
      amount: '50000.00',
    };

    it('reenviar la misma operación con la misma clave devuelve la transacción ya registrada, sin mover dinero otra vez ni avisar', async () => {
      const t = armar();
      t.yaExiste(yaRegistrada);

      const resultado = await t.ledger.transfer(transferencia(), ANA, TOKEN);

      expect(resultado).toBe(yaRegistrada);
      expect(t.escrituras()).toBe(0);
      expect(t.outbox.flush).not.toHaveBeenCalled();
    });

    it('la misma clave con otro monto, otro destino u otro usuario es un conflicto (409), no una repetición', async () => {
      const otroMonto = armar();
      otroMonto.yaExiste(yaRegistrada);
      await expect(otroMonto.ledger.transfer(transferencia({ amount: 60_000 }), ANA, TOKEN)).rejects.toThrow(
        new ConflictException('La clave de idempotencia ya se usó para otra operación.'),
      );

      const otroUsuario = armar();
      otroUsuario.yaExiste(yaRegistrada);
      await expect(otroUsuario.ledger.transfer(transferencia(), CARLOS, TOKEN)).rejects.toBeInstanceOf(
        ConflictException,
      );

      const otroDestino = armar();
      otroDestino.yaExiste({ ...yaRegistrada, destinationAccountId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
      await expect(otroDestino.ledger.transfer(transferencia(), ANA, TOKEN)).rejects.toBeInstanceOf(ConflictException);

      for (const t of [otroMonto, otroUsuario, otroDestino]) expect(t.escrituras()).toBe(0);
    });
  });

  describe('reversos', () => {
    const original = {
      id: 'tx-original',
      type: 'transfer',
      sourceAccountId: ORIGEN,
      destinationAccountId: DESTINO,
      sourceAccountNumber: '10000000001',
      destinationAccountNumber: '10000000002',
      amount: '50000.00',
      currency: 'COP',
    };
    const reverso = { idempotencyKey: CLAVE, reason: 'Error de digitación' };

    it('el dinero vuelve: sale de quien lo recibió y entra a quien lo envió, con el mismo monto y avisando a ambos', async () => {
      const t = armar();
      t.transacciones.findOne.mockResolvedValue(original);
      t.saldos.set(DESTINO, '60000.00');

      const resultado = await t.ledger.reverse('tx-original', reverso);

      expect(resultado).toMatchObject({
        type: 'reversal',
        reversedTransactionId: 'tx-original',
        sourceAccountId: DESTINO,
        destinationAccountId: ORIGEN,
        amount: '50000.00',
        description: 'Reverso: Error de digitación',
        userId: null,
      });
      const [, asientos] = t.manager.save.mock.calls.find(([primero]) => primero === LedgerEntry) as unknown as [
        unknown,
        { accountId: string; amount: string }[],
      ];
      expect(asientos.map((a) => [a.accountId, a.amount])).toEqual([
        [DESTINO, '-50000.00'],
        [ORIGEN, '50000.00'],
      ]);
      expect(t.outbox.enqueue.mock.calls[0][2].map((e: any) => [e.idUser, e.direction])).toEqual([
        [CARLOS, 'out'],
        [ANA, 'in'],
      ]);
      // Un reverso devuelve dinero: no consulta ni consume el cupo diario o mensual
      expect(t.manager.query.mock.calls.some(([sql]) => String(sql).includes('FROM ledger_entries'))).toBe(false);
    });

    it('si quien recibió ya gastó el dinero, el reverso no le deja saldo negativo (400) y no escribe nada', async () => {
      const t = armar();
      t.transacciones.findOne.mockResolvedValue(original);
      t.saldos.set(DESTINO, '10000.00');

      await expect(t.ledger.reverse('tx-original', reverso)).rejects.toThrow(
        new BadRequestException('Saldo insuficiente.'),
      );

      expect(t.escrituras()).toBe(0);
    });

    it('no se reversa lo que no existe (404), un reverso (400) ni una transacción ya reversada (409)', async () => {
      const inexistente = armar();
      inexistente.transacciones.findOne.mockResolvedValue(null);
      await expect(inexistente.ledger.reverse('tx-x', reverso)).rejects.toBeInstanceOf(NotFoundException);

      const unReverso = armar();
      unReverso.transacciones.findOne.mockResolvedValue({ ...original, type: 'reversal' });
      await expect(unReverso.ledger.reverse('tx-original', reverso)).rejects.toThrow(
        'Un reverso no se puede reversar.',
      );

      const repetida = armar();
      repetida.transacciones.findOne.mockResolvedValue(original);
      repetida.saldos.set(DESTINO, '60000.00');
      repetida.yaFueReversada({ id: 'tx-reverso-previo' });
      await expect(repetida.ledger.reverse('tx-original', reverso)).rejects.toThrow(
        new ConflictException('La transacción ya fue reversada.'),
      );

      for (const t of [inexistente, unReverso, repetida]) expect(t.escrituras()).toBe(0);
    });

    it('el reverso de una operación contra una cuenta del sistema no exige saldo a esa cuenta, que puede quedar en negativo', async () => {
      const t = armar();
      const compensacion = '00000000-0000-4000-8000-000000000001';
      t.transacciones.findOne.mockResolvedValue({
        ...original,
        type: 'credit',
        sourceAccountId: compensacion,
        destinationAccountId: ORIGEN,
      });
      t.saldos.set(ORIGEN, '50000.00');
      t.saldos.set(compensacion, '-50000.00');

      await expect(t.ledger.reverse('tx-original', reverso)).resolves.toMatchObject({
        sourceAccountId: ORIGEN,
        destinationAccountId: compensacion,
      });
    });
  });

  describe('conflictos de concurrencia (serialization_failure, deadlock, clave duplicada)', () => {
    const conflicto = (code: string) => Object.assign(new Error('conflicto'), { code });

    it('reintenta la transacción completa y termina bien, escribiendo una sola vez', async () => {
      const t = armar();
      const real = t.dataSource.transaction.getMockImplementation()!;
      t.dataSource.transaction
        .mockRejectedValueOnce(conflicto('40001'))
        .mockRejectedValueOnce(conflicto('40P01'))
        .mockImplementation(real);

      const resultado = await t.ledger.transfer(transferencia(), ANA, TOKEN);

      expect(resultado).toMatchObject({ type: 'transfer', amount: '50000.00' });
      expect(t.dataSource.transaction).toHaveBeenCalledTimes(3);
      expect(t.outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it('se rinde tras 4 intentos y devuelve el error; uno que no es de concurrencia no se reintenta', async () => {
      const agotado = armar();
      agotado.dataSource.transaction.mockRejectedValue(conflicto('40001'));
      await expect(agotado.ledger.transfer(transferencia(), ANA, TOKEN)).rejects.toMatchObject({ code: '40001' });
      expect(agotado.dataSource.transaction).toHaveBeenCalledTimes(4);

      const otroError = armar();
      otroError.dataSource.transaction.mockRejectedValue(conflicto('23503'));
      await expect(otroError.ledger.transfer(transferencia(), ANA, TOKEN)).rejects.toMatchObject({ code: '23503' });
      expect(otroError.dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(otroError.outbox.flush).not.toHaveBeenCalled();
    });
  });
});
