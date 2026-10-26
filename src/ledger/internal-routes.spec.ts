import { INestApplication, Module, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { InternalBalanceController, InternalLedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

const KEYS = {
  account: 'a'.repeat(40) + 'cuenta-1',
  deposit: 'd'.repeat(40) + 'deposito',
  transfer: 't'.repeat(40) + 'transfer',
};
const ACCOUNT_ID = '3a000000-0000-4000-8000-000000000001';
const TX_ID = '3c000000-0000-4000-8000-000000000001';

// LedgerService simulado: si una petición llega hasta aquí, responde 200/201.
const reached = async () => ({ ok: true });
const ledger = Object.fromEntries(
  ['credit', 'debit', 'payment', 'reward', 'savings', 'cashIn', 'reverse', 'reconcile', 'getInternalBalance'].map(
    (method) => [method, reached],
  ),
);

@Module({
  controllers: [InternalLedgerController, InternalBalanceController],
  providers: [
    { provide: LedgerService, useValue: ledger },
    {
      provide: ConfigService,
      useValue: new ConfigService({
        INTERNAL_TRUSTED_KEYS: Object.entries(KEYS)
          .map(([caller, key]) => `${caller}:${key}`)
          .join(','),
      }),
    },
  ],
})
class InternalRoutesTestModule {}

/** Todas las rutas del controlador que mueve dinero, leídas de sus decoradores. */
function moneyRoutes(): { method: 'GET' | 'POST'; path: string }[] {
  const base = Reflect.getMetadata(PATH_METADATA, InternalLedgerController) as string;
  const proto = InternalLedgerController.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name] as object)
    .filter((handler) => Reflect.hasMetadata(PATH_METADATA, handler))
    .map((handler) => {
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number] as 'GET' | 'POST';
      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string).replace(':transaction_id', TX_ID);
      return { method, path: `/${base}/${sub}` };
    });
}

/**
 * Con la clave de account-service, el ledger solo deja leer saldos: TODAS las
 * rutas de /ledger/internal que mueven dinero responden 403. Peticiones HTTP
 * reales contra la app de Nest, con las guardas de verdad (InternalKeyGuard y
 * MoneyCallerGuard).
 */
describe('Rutas internas del ledger con la clave de account (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(InternalRoutesTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const call = async (method: string, path: string, key?: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) },
      body: method === 'GET' ? undefined : '{}',
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  it('el controlador tiene las 8 rutas conocidas (si se agrega una, entra sola en estas pruebas)', () => {
    expect(moneyRoutes().map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /ledger/internal/credits',
      'POST /ledger/internal/debits',
      'POST /ledger/internal/payments',
      'POST /ledger/internal/rewards',
      'POST /ledger/internal/savings',
      'POST /ledger/internal/cash-ins',
      `POST /ledger/internal/transactions/${TX_ID}/reversal`,
      'GET /ledger/internal/reconciliation',
    ]);
  });

  it.each(moneyRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))(
    'account recibe 403 en %s',
    async (_label, route) => {
      const { status, body } = await call(route.method, route.path, KEYS.account);
      expect(status).toBe(403);
      expect(body.message).toBe('Este servicio no puede registrar movimientos en el ledger.');
    },
  );

  it.each(moneyRoutes().map((r) => [`${r.method} ${r.path}`, r] as const))(
    'deposit (servicio que sí mueve dinero) pasa las guardas en %s',
    async (_label, route) => {
      const { status } = await call(route.method, route.path, KEYS.deposit);
      expect([200, 201]).toContain(status);
    },
  );

  it('transfer sigue pasando (y cash-ins sigue siendo solo de deposit)', async () => {
    expect((await call('POST', '/ledger/internal/credits', KEYS.transfer)).status).toBe(201);
    expect((await call('POST', '/ledger/internal/cash-ins', KEYS.transfer)).status).toBe(403);
  });

  it('sin clave o con una clave desconocida: 401', async () => {
    expect((await call('POST', '/ledger/internal/credits')).status).toBe(401);
    expect((await call('POST', '/ledger/internal/credits', 'x'.repeat(48))).status).toBe(401);
  });

  it('el saldo interno: account sí (200); los demás servicios no (403)', async () => {
    const path = `/ledger/internal/accounts/${ACCOUNT_ID}/balance`;
    expect((await call('GET', path, KEYS.account)).status).toBe(200);
    expect((await call('GET', path, KEYS.transfer)).status).toBe(403);
    expect((await call('GET', path, KEYS.deposit)).status).toBe(403);
    expect((await call('GET', path)).status).toBe(401);
  });
});
