import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { InternalBalanceController, MoneyCallerGuard } from './ledger.controller';
import { LedgerService } from './ledger.service';

const contextFor = (internalCaller?: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ internalCaller }) }) }) as unknown as ExecutionContext;

/** account-service solo puede leer saldos: su clave interna no sirve para mover dinero. */
describe('Llamadas internas al ledger según quién llama', () => {
  const guard = new MoneyCallerGuard();

  it('account no puede usar las rutas que mueven dinero', () => {
    expect(() => guard.canActivate(contextFor('account'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('los servicios que mueven dinero siguen pasando', () => {
    for (const caller of ['transfer', 'card', 'payment', 'rewards', 'savings', 'deposit']) {
      expect(guard.canActivate(contextFor(caller))).toBe(true);
    }
  });

  it('el saldo interno solo lo puede pedir account', async () => {
    const ledger = { getInternalBalance: jest.fn(async (accountId: string) => ({ accountId, balance: 0 })) };
    const controller = new InternalBalanceController(ledger as unknown as LedgerService);
    const id = '3a000000-0000-4000-8000-000000000001';

    await expect(controller.balance(id, { internalCaller: 'account' } as any)).resolves.toEqual({
      accountId: id,
      balance: 0,
    });
    for (const caller of ['transfer', 'savings', undefined]) {
      expect(() => controller.balance(id, { internalCaller: caller } as any)).toThrow(ForbiddenException);
    }
  });
});
