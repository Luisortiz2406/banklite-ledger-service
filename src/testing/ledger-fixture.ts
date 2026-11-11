import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAudit } from '../common/staff/admin-audit.entity';
import { AccountsClientService, LedgerAccountInfo } from '../ledger/accounts-client.service';
import { LedgerBalance } from '../ledger/entities/ledger-balance.entity';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { LedgerOutbox } from '../ledger/entities/ledger-outbox.entity';
import { LedgerTransaction } from '../ledger/entities/ledger-transaction.entity';
import { EventPublisherService } from '../ledger/event-publisher.service';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../ledger/outbox.service';
import { createTestDatabase } from './test-database';

/**
 * Ledger real sobre una base PostgreSQL temporal, con account-service simulado
 * (el token de acceso es el idUser del titular) y sin RabbitMQ: los eventos
 * quedan en ledger_outbox. Lo usan las pruebas de operaciones, del outbox y del panel.
 */

export const ANA = '11111111-1111-4111-8111-111111111111';
export const CARLOS = '22222222-2222-4222-8222-222222222222';
/** Dueño de sistema de las cuentas de comercio (igual que en ledger.service.ts). */
export const MERCHANT_OWNER = '00000000-0000-4000-8000-0000000000aa';

export const SYSTEM = {
  clearing: '00000000-0000-4000-8000-000000000001',
  demoDeposit: '00000000-0000-4000-8000-000000000003',
  adminCredit: '00000000-0000-4000-8000-000000000005',
  rewards: '00000000-0000-4000-8000-000000000007',
  pocketCustody: '00000000-0000-4000-8000-000000000009',
  cdtCustody: '00000000-0000-4000-8000-000000000011',
  interest: '00000000-0000-4000-8000-000000000013',
};

export const account = (
  id: string,
  accountNumber: string,
  idUser: string,
  overrides: Partial<LedgerAccountInfo> = {},
): LedgerAccountInfo => ({
  id,
  accountNumber,
  accountType: 'savings',
  idUser,
  currency: 'COP',
  status: 'active',
  dailyLimit: 5_000_000,
  monthlyLimit: 50_000_000,
  ...overrides,
});

export async function createLedgerFixture(env: Record<string, string> = {}) {
  const accounts = new Map<string, LedgerAccountInfo>();
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

  const { dataSource, drop } = await createTestDatabase('ledger', [
    LedgerBalance,
    LedgerEntry,
    LedgerTransaction,
    LedgerOutbox,
    AdminAudit,
  ]);
  const publisher = { isReady: jest.fn(() => false), publish: jest.fn() };
  const outbox = new OutboxService(dataSource, publisher as unknown as EventPublisherService);
  const config = new ConfigService({ NODE_ENV: 'test', ...env });
  const ledger = new LedgerService(
    dataSource,
    dataSource.getRepository(LedgerBalance),
    dataSource.getRepository(LedgerEntry),
    dataSource.getRepository(LedgerTransaction),
    accountsClient,
    outbox,
    config,
  );

  return {
    dataSource,
    drop,
    accounts,
    accountsClient,
    publisher,
    outbox,
    config,
    ledger,
    balanceOf: async (accountId: string) =>
      Number((await dataSource.getRepository(LedgerBalance).findOneBy({ accountId }))?.balance ?? 0),
    entriesOf: (transactionId: string) => dataSource.getRepository(LedgerEntry).findBy({ transactionId }),
    count: (entity: typeof LedgerTransaction | typeof LedgerEntry | typeof LedgerOutbox) =>
      dataSource.getRepository(entity).count(),
  };
}
