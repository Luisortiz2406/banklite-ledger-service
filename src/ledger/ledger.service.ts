import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AccountsClientService, LedgerAccountInfo } from './accounts-client.service';
import { CreditDto } from './dto/credit.dto';
import { TransferDto } from './dto/transfer.dto';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { EventPublisherService } from './event-publisher.service';

const CLEARING_ACCOUNTS: Record<string, string> = {
  COP: '00000000-0000-4000-8000-000000000001',
  USD: '00000000-0000-4000-8000-000000000002',
};

// Errores de PostgreSQL que se resuelven reintentando la transacción completa:
// 40001 serialization_failure, 40P01 deadlock_detected y 23505 unique_violation
// (dos peticiones con la misma clave de idempotencia: el reintento encuentra la
// transacción ya creada y la devuelve).
const RETRYABLE_PG_CODES = new Set(['40001', '40P01', '23505']);
const MAX_TX_ATTEMPTS = 4;

// Los límites diarios/mensuales se cuentan en hora de Colombia (UTC-5, sin horario de verano).
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

@Injectable()
export class LedgerService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(LedgerBalance) private readonly balances: Repository<LedgerBalance>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
    @InjectRepository(LedgerTransaction) private readonly transactions: Repository<LedgerTransaction>,
    private readonly accounts: AccountsClientService,
    private readonly events: EventPublisherService,
    private readonly config: ConfigService,
  ) {}

  async getBalance(accountId: string, userId: string, accessToken: string) {
    const account = await this.accounts.getOwnedAccount(accountId, accessToken);
    const balance = await this.balances.findOne({ where: { accountId } });
    return {
      accountId,
      currency: account.currency,
      balance: balance ? Number(balance.balance) : 0,
    };
  }

  async getTransactions(accountId: string, userId: string, accessToken: string) {
    await this.accounts.getOwnedAccount(accountId, accessToken);
    const entries = await this.entries.find({
      where: { accountId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    if (!entries.length) return [];
    const transactions = await this.transactions.find({
      where: { id: In(entries.map((entry) => entry.transactionId)) },
    });
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
    return entries.map((entry) => {
      const transaction = byId.get(entry.transactionId);
      return {
        id: entry.id,
        transactionId: entry.transactionId,
        type: transaction?.type ?? 'transfer',
        direction: Number(entry.amount) >= 0 ? 'in' : 'out',
        amount: Math.abs(Number(entry.amount)),
        currency: entry.currency,
        description: transaction?.description ?? 'Movimiento',
        counterpartyAccountId: transaction?.type === 'credit'
          ? null
          : transaction?.sourceAccountId === accountId
            ? transaction.destinationAccountId
            : transaction?.sourceAccountId,
        createdAt: entry.createdAt,
      };
    });
  }

  async transfer(dto: TransferDto, userId: string, accessToken: string) {
    const [source, destination] = await Promise.all([
      this.accounts.getOwnedAccount(dto.sourceAccountId, accessToken),
      this.accounts.getInternalAccountByNumber(dto.destinationAccountNumber),
    ]);
    if (source.id === destination.id) {
      throw new BadRequestException('La cuenta destino debe ser diferente a la cuenta de origen.');
    }
    this.assertActive(source, 'origen');
    this.assertActive(destination, 'destino');
    if (source.currency !== destination.currency) {
      throw new BadRequestException('Las cuentas deben usar la misma moneda.');
    }
    const limits = await this.accounts.getLimits(source.id, accessToken);
    const amount = this.money(dto.amount);

    const result = await this.runSerializable(async (manager) => {
      const existing = await manager.findOne(LedgerTransaction, { where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        if (existing.type !== 'transfer' || existing.userId !== userId || existing.sourceAccountId !== source.id ||
          existing.destinationAccountId !== destination.id || Number(existing.amount) !== Number(amount)) {
          throw new ConflictException('La clave de idempotencia ya se usó para otra operación.');
        }
        return { transaction: existing, created: false };
      }

      const lockedBalances = await this.lockBalances(manager, [source.id, destination.id], source.currency);
      const sourceBalance = Number(lockedBalances.get(source.id));
      if (sourceBalance < Number(amount)) throw new BadRequestException('Saldo insuficiente.');
      await this.assertWithinLimits(manager, source.id, Number(amount), limits);

      const row = manager.create(LedgerTransaction, {
        idempotencyKey: dto.idempotencyKey,
        userId,
        type: 'transfer',
        sourceAccountId: source.id,
        destinationAccountId: destination.id,
        amount,
        currency: source.currency,
        description: this.description(dto.description, 'Transferencia'),
      });
      await manager.save(row);
      await manager.save(LedgerEntry, [
        manager.create(LedgerEntry, { transactionId: row.id, accountId: source.id, amount: `-${amount}`, currency: source.currency }),
        manager.create(LedgerEntry, { transactionId: row.id, accountId: destination.id, amount, currency: source.currency }),
      ]);
      await manager.query('UPDATE ledger_balances SET balance = balance - $1::numeric, updated_at = NOW() WHERE account_id = $2', [amount, source.id]);
      await manager.query('UPDATE ledger_balances SET balance = balance + $1::numeric, updated_at = NOW() WHERE account_id = $2', [amount, destination.id]);
      return { transaction: row, created: true };
    });

    if (result.created) {
      const common = {
        transactionId: result.transaction.id,
        type: 'transfer',
        sourceAccountId: source.id,
        sourceAccountNumber: source.accountNumber,
        destinationAccountId: destination.id,
        destinationAccountNumber: destination.accountNumber,
        amount: Number(result.transaction.amount),
        currency: result.transaction.currency,
      };
      // Un evento por cada titular: quien envía y quien recibe.
      await this.events.publishTransactionCompleted({ ...common, idUser: userId, direction: 'out' });
      if (destination.idUser !== userId) {
        await this.events.publishTransactionCompleted({ ...common, idUser: destination.idUser, direction: 'in' });
      }
    }
    return result.transaction;
  }

  async credit(dto: CreditDto) {
    const destination = await this.accounts.getInternalAccount(dto.accountId);
    this.assertActive(destination, 'destino');
    const clearingAccountId = CLEARING_ACCOUNTS[destination.currency];
    if (!clearingAccountId) throw new BadRequestException('Moneda no soportada para créditos internos.');
    const amount = this.money(dto.amount);

    const result = await this.runSerializable(async (manager) => {
      const existing = await manager.findOne(LedgerTransaction, { where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        if (existing.type !== 'credit' || existing.destinationAccountId !== destination.id || Number(existing.amount) !== Number(amount)) {
          throw new ConflictException('La clave de idempotencia ya se usó para otra operación.');
        }
        return { transaction: existing, created: false };
      }
      await this.lockBalances(manager, [clearingAccountId, destination.id], destination.currency);
      const row = manager.create(LedgerTransaction, {
        idempotencyKey: dto.idempotencyKey,
        userId: null,
        type: 'credit',
        sourceAccountId: clearingAccountId,
        destinationAccountId: destination.id,
        amount,
        currency: destination.currency,
        description: this.description(dto.description, 'Abono'),
      });
      await manager.save(row);
      await manager.save(LedgerEntry, [
        manager.create(LedgerEntry, { transactionId: row.id, accountId: clearingAccountId, amount: `-${amount}`, currency: destination.currency }),
        manager.create(LedgerEntry, { transactionId: row.id, accountId: destination.id, amount, currency: destination.currency }),
      ]);
      await manager.query('UPDATE ledger_balances SET balance = balance - $1::numeric, updated_at = NOW() WHERE account_id = $2', [amount, clearingAccountId]);
      await manager.query('UPDATE ledger_balances SET balance = balance + $1::numeric, updated_at = NOW() WHERE account_id = $2', [amount, destination.id]);
      return { transaction: row, created: true };
    });

    if (result.created) {
      await this.events.publishTransactionCompleted({
        idUser: destination.idUser,
        transactionId: result.transaction.id,
        type: 'credit',
        direction: 'in',
        destinationAccountId: destination.id,
        destinationAccountNumber: destination.accountNumber,
        amount: Number(result.transaction.amount),
        currency: result.transaction.currency,
      });
    }
    return result.transaction;
  }

  /** Ejecuta la transacción SERIALIZABLE reintentando los conflictos de concurrencia. */
  private async runSerializable<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction('SERIALIZABLE', work);
      } catch (error) {
        const code = (error as any)?.code ?? (error as any)?.driverError?.code;
        if (!RETRYABLE_PG_CODES.has(code) || attempt >= MAX_TX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.random() * 30));
      }
    }
  }

  private assertActive(account: LedgerAccountInfo, label: string) {
    if (account.status !== 'active') throw new BadRequestException(`La cuenta de ${label} no está activa.`);
  }

  private money(value: number): string {
    return value.toFixed(2);
  }

  private description(value: string | undefined, fallback: string) {
    return value?.trim() || fallback;
  }

  private async lockBalances(manager: EntityManager, accountIds: string[], currency: string) {
    const sortedIds = [...new Set(accountIds)].sort();
    for (const accountId of sortedIds) {
      await manager.query(
        'INSERT INTO ledger_balances (account_id, currency, balance) VALUES ($1, $2, 0) ON CONFLICT (account_id) DO NOTHING',
        [accountId, currency],
      );
    }
    const rows = await manager.query(
      'SELECT account_id, currency, balance FROM ledger_balances WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',
      [sortedIds],
    );
    const balances = new Map<string, string>();
    for (const row of rows) {
      if (row.currency !== currency) throw new ConflictException('La moneda del saldo no coincide con la cuenta.');
      balances.set(row.account_id, row.balance);
    }
    if (balances.size !== sortedIds.length) throw new NotFoundException('No se pudo inicializar el saldo de la cuenta.');
    return balances;
  }

  private async assertWithinLimits(
    manager: EntityManager,
    accountId: string,
    amount: number,
    limits: { dailyLimit: number; monthlyLimit: number },
  ) {
    // "Ahora" expresado en hora de Bogotá; los inicios se devuelven como instantes UTC reales.
    const bogota = new Date(Date.now() - BOGOTA_OFFSET_MS);
    const dayStart = new Date(
      Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate()) + BOGOTA_OFFSET_MS,
    );
    const monthStart = new Date(Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), 1) + BOGOTA_OFFSET_MS);
    const [dailyRows, monthlyRows] = await Promise.all([
      manager.query(
        'SELECT COALESCE(SUM(-amount), 0) AS total FROM ledger_entries WHERE account_id = $1 AND amount < 0 AND created_at >= $2',
        [accountId, dayStart],
      ),
      manager.query(
        'SELECT COALESCE(SUM(-amount), 0) AS total FROM ledger_entries WHERE account_id = $1 AND amount < 0 AND created_at >= $2',
        [accountId, monthStart],
      ),
    ]);
    if (Number(dailyRows[0].total) + amount > Number(limits.dailyLimit)) {
      throw new ForbiddenException('La transferencia supera el límite diario de la cuenta.');
    }
    if (Number(monthlyRows[0].total) + amount > Number(limits.monthlyLimit)) {
      throw new ForbiddenException('La transferencia supera el límite mensual de la cuenta.');
    }
  }
}