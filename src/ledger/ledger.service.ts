import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { And, DataSource, EntityManager, FindOptionsWhere, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AccountsClientService, LedgerAccountInfo } from './accounts-client.service';
import { CreditDto } from './dto/credit.dto';
import { DebitDto } from './dto/debit.dto';
import { DepositDto } from './dto/deposit.dto';
import { PaymentDto } from './dto/payment.dto';
import { ReversalDto } from './dto/reversal.dto';
import { StatementQueryDto, TransactionsQueryDto } from './dto/transactions-query.dto';
import { TransferDto } from './dto/transfer.dto';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction, LedgerTransactionType } from './entities/ledger-transaction.entity';
import { OutboxService } from './outbox.service';

// Cuentas del sistema (contrapartida de la doble partida). Pueden quedar en negativo.
// Compensación: abonos externos y cargos internos (p. ej. compras con tarjeta).
const CLEARING_ACCOUNTS: Record<string, string> = {
  COP: '00000000-0000-4000-8000-000000000001',
  USD: '00000000-0000-4000-8000-000000000002',
};
// Origen de las consignaciones de prueba: separado para poder identificarlas y depurarlas.
const DEMO_DEPOSIT_ACCOUNTS: Record<string, string> = {
  COP: '00000000-0000-4000-8000-000000000003',
  USD: '00000000-0000-4000-8000-000000000004',
};
// Dueño de sistema de las cuentas de comercio (account-service): no es un cliente,
// así que nunca recibe eventos ni notificaciones.
const MERCHANT_OWNER_ID = '00000000-0000-4000-8000-0000000000aa';

// Contrapartida de los abonos que hace el personal del banco desde el panel
// administrativo: separada para identificarlos en la reconciliación.
const ADMIN_CREDIT_ACCOUNTS: Record<string, string> = {
  COP: '00000000-0000-4000-8000-000000000005',
  USD: '00000000-0000-4000-8000-000000000006',
};
const SYSTEM_ACCOUNT_IDS = new Set([
  ...Object.values(CLEARING_ACCOUNTS),
  ...Object.values(DEMO_DEPOSIT_ACCOUNTS),
  ...Object.values(ADMIN_CREDIT_ACCOUNTS),
]);
// Nombre de cada cuenta del sistema, para mostrarlas en la reconciliación.
const SYSTEM_ACCOUNT_NAMES: Record<string, string> = Object.fromEntries([
  ...Object.entries(CLEARING_ACCOUNTS).map(([currency, id]) => [id, `Compensación ${currency}`]),
  ...Object.entries(DEMO_DEPOSIT_ACCOUNTS).map(([currency, id]) => [id, `Consignaciones de prueba ${currency}`]),
  ...Object.entries(ADMIN_CREDIT_ACCOUNTS).map(([currency, id]) => [id, `Abonos administrativos ${currency}`]),
]);
const DEFAULT_ADMIN_CREDIT_MAX = 10_000_000;

// Errores de PostgreSQL que se resuelven reintentando la transacción completa:
// 40001 serialization_failure, 40P01 deadlock_detected y 23505 unique_violation
// (dos peticiones con la misma clave de idempotencia: el reintento encuentra la
// transacción ya creada y la devuelve).
const RETRYABLE_PG_CODES = new Set(['40001', '40P01', '23505']);
const MAX_TX_ATTEMPTS = 4;

// Los límites diarios/mensuales se cuentan en hora de Colombia (UTC-5, sin horario de verano).
const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

const DEFAULT_PAGE_SIZE = 50;
const MAX_STATEMENT_DAYS = 366;
const MAX_STATEMENT_MOVEMENTS = 1000;
const DEFAULT_DEMO_DEPOSIT_MAX = 5_000_000;

const EVENT_TRANSACTION_COMPLETED = 'transaction.completed';

interface Limits {
  dailyLimit: number;
  monthlyLimit: number;
}

interface Posting {
  idempotencyKey: string;
  userId: string | null;
  type: LedgerTransactionType;
  // Cuenta que se debita (asiento negativo) y cuenta que se acredita (asiento positivo).
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  currency: string;
  description: string;
  sourceAccountNumber?: string | null;
  destinationAccountNumber?: string | null;
  reversedTransactionId?: string | null;
  // Cuenta de cliente que no puede quedar en negativo (las del sistema sí pueden).
  requireFundsIn?: string;
  limits?: Limits;
  // Una reentrega con la misma clave de idempotencia debe ser exactamente la misma operación.
  isSameOperation: (existing: LedgerTransaction) => boolean;
  // Eventos transaction.completed (uno por titular afectado), guardados en el outbox.
  events: (transaction: LedgerTransaction) => Record<string, unknown>[];
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(LedgerBalance) private readonly balances: Repository<LedgerBalance>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
    @InjectRepository(LedgerTransaction) private readonly transactions: Repository<LedgerTransaction>,
    private readonly accounts: AccountsClientService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
  ) {}

  async getBalance(accountId: string, accessToken: string) {
    const account = await this.accounts.getOwnedAccount(accountId, accessToken);
    const balance = await this.balances.findOne({ where: { accountId } });
    return {
      accountId,
      currency: account.currency,
      balance: balance ? Number(balance.balance) : 0,
    };
  }

  /** Movimientos de una cuenta propia, del más reciente al más antiguo, paginados y filtrables por fecha. */
  async getTransactions(accountId: string, accessToken: string, query: TransactionsQueryDto) {
    await this.accounts.getOwnedAccount(accountId, accessToken);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to && from >= to) throw new BadRequestException('La fecha inicial debe ser anterior a la final.');

    const where: FindOptionsWhere<LedgerEntry> = { accountId };
    if (from && to) where.createdAt = And(MoreThanOrEqual(from), LessThan(to));
    else if (from) where.createdAt = MoreThanOrEqual(from);
    else if (to) where.createdAt = LessThan(to);

    const entries = await this.entries.find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return this.toMovements(accountId, entries);
  }

  /** Extracto: saldo inicial, movimientos del periodo (más antiguo primero) y saldo final. */
  async getStatement(accountId: string, accessToken: string, query: StatementQueryDto) {
    const account = await this.accounts.getOwnedAccount(accountId, accessToken);
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) throw new BadRequestException('La fecha inicial debe ser anterior a la final.');
    if (to.getTime() - from.getTime() > MAX_STATEMENT_DAYS * 24 * 60 * 60 * 1000) {
      throw new BadRequestException(`El extracto puede cubrir máximo ${MAX_STATEMENT_DAYS} días.`);
    }

    const [[opening], [totals], entries] = await Promise.all([
      this.dataSource.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_id = $1 AND created_at < $2',
        [accountId, from],
      ),
      this.dataSource.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS total_in,
                COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0) AS total_out,
                COUNT(*) AS count
           FROM ledger_entries WHERE account_id = $1 AND created_at >= $2 AND created_at < $3`,
        [accountId, from, to],
      ),
      this.entries.find({
        where: { accountId, createdAt: And(MoreThanOrEqual(from), LessThan(to)) },
        order: { createdAt: 'ASC', id: 'ASC' },
        take: MAX_STATEMENT_MOVEMENTS,
      }),
    ]);

    const openingBalance = Number(opening.total);
    const totalIn = Number(totals.total_in);
    const totalOut = Number(totals.total_out);
    return {
      accountId,
      accountNumber: account.accountNumber,
      currency: account.currency,
      from: from.toISOString(),
      to: to.toISOString(),
      openingBalance,
      totalIn,
      totalOut,
      closingBalance: Number((openingBalance + totalIn - totalOut).toFixed(2)),
      movementCount: Number(totals.count),
      truncated: Number(totals.count) > entries.length,
      movements: await this.toMovements(accountId, entries),
    };
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
    if (destination.accountType === 'merchant') {
      throw new BadRequestException('La cuenta destino es de un comercio y no recibe transferencias.');
    }
    if (source.currency !== destination.currency) {
      throw new BadRequestException('Las cuentas deben usar la misma moneda.');
    }
    const limits = await this.accounts.getLimits(source.id, accessToken);
    const amount = this.money(dto.amount);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId,
      type: 'transfer',
      fromAccountId: source.id,
      toAccountId: destination.id,
      amount,
      currency: source.currency,
      description: this.description(dto.description, 'Transferencia'),
      sourceAccountNumber: source.accountNumber,
      destinationAccountNumber: destination.accountNumber,
      requireFundsIn: source.id,
      limits,
      isSameOperation: (existing) => existing.type === 'transfer' && existing.userId === userId &&
        existing.sourceAccountId === source.id && existing.destinationAccountId === destination.id &&
        Number(existing.amount) === Number(amount),
      events: (transaction) => {
        // Un evento por cada titular: quien envía y quien recibe.
        const events = [this.eventPayload(transaction, source.idUser, 'out')];
        if (destination.idUser !== source.idUser) {
          events.push(this.eventPayload(transaction, destination.idUser, 'in'));
        }
        return events;
      },
    });
  }

  /** Abono externo (uso interno) contra la cuenta de compensación. */
  async credit(dto: CreditDto) {
    const destination = await this.accounts.getInternalAccount(dto.accountId);
    this.assertActive(destination, 'destino');
    const clearingAccountId = this.systemAccount(CLEARING_ACCOUNTS, destination.currency);
    const amount = this.money(dto.amount);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId: null,
      type: 'credit',
      fromAccountId: clearingAccountId,
      toAccountId: destination.id,
      amount,
      currency: destination.currency,
      description: this.description(dto.description, 'Abono'),
      destinationAccountNumber: destination.accountNumber,
      isSameOperation: (existing) => existing.type === 'credit' &&
        existing.destinationAccountId === destination.id && Number(existing.amount) === Number(amount),
      events: (transaction) => [this.eventPayload(transaction, destination.idUser, 'in')],
    });
  }

  /**
   * Abono administrativo (panel del banco): a una cuenta de cliente por su número,
   * contra la cuenta de sistema "Abonos administrativos". La idempotencia evita
   * abonar dos veces si el funcionario reenvía el formulario.
   */
  async adminCredit(dto: { accountNumber: string; amount: number; reason: string; idempotencyKey: string }) {
    const destination = await this.accounts.getInternalAccountByNumber(dto.accountNumber);
    if (destination.accountType === 'merchant') {
      throw new BadRequestException('No se pueden hacer abonos a cuentas de comercio.');
    }
    this.assertActive(destination, 'destino');
    const max = this.adminCreditMax();
    if (dto.amount > max) throw new BadRequestException(`El abono no puede superar ${max}.`);
    const sourceAccountId = this.systemAccount(ADMIN_CREDIT_ACCOUNTS, destination.currency);
    const amount = this.money(dto.amount);

    const transaction = await this.post({
      idempotencyKey: dto.idempotencyKey,
      userId: null,
      type: 'credit',
      fromAccountId: sourceAccountId,
      toAccountId: destination.id,
      amount,
      currency: destination.currency,
      description: `Abono BankLite: ${dto.reason.trim()}`.slice(0, 140),
      destinationAccountNumber: destination.accountNumber,
      isSameOperation: (existing) => existing.type === 'credit' && existing.sourceAccountId === sourceAccountId &&
        existing.destinationAccountId === destination.id && Number(existing.amount) === Number(amount),
      events: (row) => [this.eventPayload(row, destination.idUser, 'in')],
    });
    return { transaction, account: destination };
  }

  private adminCreditMax(): number {
    const configured = Number(this.config.get<string>('ADMIN_CREDIT_MAX_AMOUNT'));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ADMIN_CREDIT_MAX;
  }

  /** Configuración que la app consulta para mostrar (o no) la consignación de prueba. */
  getDemoDepositsConfig() {
    return { enabled: this.demoDepositsBlockedReason() === null, maxAmount: this.demoDepositMax() };
  }

  /** Consignación de prueba del titular a su propia cuenta, contra la cuenta del sistema de depósitos. */
  async deposit(accountId: string, dto: DepositDto, userId: string, accessToken: string) {
    const blockedReason = this.demoDepositsBlockedReason();
    if (blockedReason) throw new ForbiddenException(blockedReason);
    const max = this.demoDepositMax();
    if (dto.amount > max) {
      throw new BadRequestException(`La consignación de prueba no puede superar ${max}.`);
    }

    const account = await this.accounts.getOwnedAccount(accountId, accessToken);
    this.assertActive(account, 'destino');
    const systemAccountId = this.systemAccount(DEMO_DEPOSIT_ACCOUNTS, account.currency);
    const amount = this.money(dto.amount);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId,
      type: 'deposit',
      fromAccountId: systemAccountId,
      toAccountId: account.id,
      amount,
      currency: account.currency,
      description: this.description(dto.description, 'Consignación de prueba'),
      destinationAccountNumber: account.accountNumber,
      isSameOperation: (existing) => existing.type === 'deposit' && existing.userId === userId &&
        existing.destinationAccountId === account.id && Number(existing.amount) === Number(amount),
      events: (transaction) => [this.eventPayload(transaction, account.idUser, 'in')],
    });
  }

  /** Cargo interno (p. ej. compra con tarjeta): exige fondos y respeta los límites de la cuenta. */
  async debit(dto: DebitDto) {
    const source = await this.accounts.getInternalAccount(dto.accountId);
    this.assertActive(source, 'origen');
    const clearingAccountId = this.systemAccount(CLEARING_ACCOUNTS, source.currency);
    const amount = this.money(dto.amount);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId: source.idUser,
      type: 'debit',
      fromAccountId: source.id,
      toAccountId: clearingAccountId,
      amount,
      currency: source.currency,
      description: this.description(dto.description, 'Cargo'),
      sourceAccountNumber: source.accountNumber,
      requireFundsIn: source.id,
      limits: { dailyLimit: Number(source.dailyLimit ?? 0), monthlyLimit: Number(source.monthlyLimit ?? 0) },
      isSameOperation: (existing) => existing.type === 'debit' &&
        existing.sourceAccountId === source.id && Number(existing.amount) === Number(amount),
      events: (transaction) => [this.eventPayload(transaction, source.idUser, 'out')],
    });
  }

  /**
   * Pago a comercio (uso interno, p. ej. cobro de una suscripción): sale de la
   * cuenta del cliente y entra a la del comercio. Exige fondos y respeta los
   * límites de la cuenta, todo dentro de la misma transacción SERIALIZABLE.
   */
  async payment(dto: PaymentDto) {
    const [source, merchant] = await Promise.all([
      this.accounts.getInternalAccount(dto.sourceAccountId),
      this.accounts.getInternalAccount(dto.merchantAccountId),
    ]);
    if (source.accountType === 'merchant') throw new BadRequestException('La cuenta de origen no puede ser de un comercio.');
    if (merchant.accountType !== 'merchant') throw new BadRequestException('La cuenta destino no es de un comercio.');
    this.assertActive(source, 'origen');
    this.assertActive(merchant, 'comercio');
    if (source.currency !== merchant.currency) {
      throw new BadRequestException('Las cuentas deben usar la misma moneda.');
    }
    const amount = this.money(dto.amount);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId: source.idUser,
      type: 'payment',
      fromAccountId: source.id,
      toAccountId: merchant.id,
      amount,
      currency: source.currency,
      description: this.description(dto.description, 'Pago'),
      sourceAccountNumber: source.accountNumber,
      destinationAccountNumber: merchant.accountNumber,
      requireFundsIn: source.id,
      limits: { dailyLimit: Number(source.dailyLimit ?? 0), monthlyLimit: Number(source.monthlyLimit ?? 0) },
      isSameOperation: (existing) => existing.type === 'payment' &&
        existing.sourceAccountId === source.id && existing.destinationAccountId === merchant.id &&
        Number(existing.amount) === Number(amount),
      // Solo el cliente recibe el evento: el comercio es una cuenta de sistema.
      events: (transaction) => [this.eventPayload(transaction, source.idUser, 'out')],
    });
  }

  /**
   * Reverso (uso interno): anula una transacción con los asientos contrarios.
   * Cada transacción se puede reversar una sola vez y los reversos no se reversan.
   */
  async reverse(transactionId: string, dto: ReversalDto) {
    const original = await this.transactions.findOne({ where: { id: transactionId } });
    if (!original) throw new NotFoundException('Transacción no encontrada.');
    if (original.type === 'reversal') throw new BadRequestException('Un reverso no se puede reversar.');
    if (!original.sourceAccountId) throw new BadRequestException('La transacción no tiene cuenta de origen.');

    // El dinero vuelve: sale de quien lo recibió y entra a quien lo envió.
    const fromAccountId = original.destinationAccountId;
    const toAccountId = original.sourceAccountId;
    const [fromOwner, toOwner] = await Promise.all([
      this.ownerOf(fromAccountId),
      this.ownerOf(toAccountId),
    ]);

    return this.post({
      idempotencyKey: dto.idempotencyKey,
      userId: null,
      type: 'reversal',
      fromAccountId,
      toAccountId,
      amount: original.amount,
      currency: original.currency,
      description: `Reverso: ${dto.reason.trim()}`.slice(0, 140),
      sourceAccountNumber: original.destinationAccountNumber,
      destinationAccountNumber: original.sourceAccountNumber,
      reversedTransactionId: original.id,
      // Si quien recibió ya gastó el dinero, el reverso no puede dejarle saldo negativo.
      requireFundsIn: SYSTEM_ACCOUNT_IDS.has(fromAccountId) ? undefined : fromAccountId,
      isSameOperation: (existing) => existing.type === 'reversal' && existing.reversedTransactionId === original.id,
      events: (transaction) => {
        const events: Record<string, unknown>[] = [];
        if (fromOwner && fromOwner !== MERCHANT_OWNER_ID) events.push(this.eventPayload(transaction, fromOwner, 'out'));
        if (toOwner && toOwner !== fromOwner && toOwner !== MERCHANT_OWNER_ID) {
          events.push(this.eventPayload(transaction, toOwner, 'in'));
        }
        return events;
      },
    });
  }

  /**
   * Cuadre (uso interno): verifica que cada saldo sea igual a la suma de sus asientos
   * y que cada transacción sume cero. También informa los eventos sin publicar.
   */
  async reconcile() {
    const [balanceMismatches, orphanEntries, unbalancedTransactions, [pending], systemBalances] = await Promise.all([
      this.dataSource.query(
        `SELECT b.account_id AS "accountId", b.balance::float8 AS balance,
                COALESCE(SUM(e.amount), 0)::float8 AS "entriesTotal"
           FROM ledger_balances b LEFT JOIN ledger_entries e ON e.account_id = b.account_id
          GROUP BY b.account_id, b.balance
         HAVING b.balance <> COALESCE(SUM(e.amount), 0)`,
      ),
      this.dataSource.query(
        `SELECT e.account_id AS "accountId", SUM(e.amount)::float8 AS "entriesTotal"
           FROM ledger_entries e LEFT JOIN ledger_balances b ON b.account_id = e.account_id
          WHERE b.account_id IS NULL GROUP BY e.account_id`,
      ),
      this.dataSource.query(
        `SELECT transaction_id AS "transactionId", SUM(amount)::float8 AS total, COUNT(*)::int AS entries
           FROM ledger_entries GROUP BY transaction_id
         HAVING SUM(amount) <> 0 OR COUNT(*) <> 2`,
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest
           FROM ledger_outbox WHERE published_at IS NULL`,
      ),
      this.dataSource.query(
        `SELECT account_id AS "accountId", currency, balance::float8 AS balance
           FROM ledger_balances WHERE account_id = ANY($1::uuid[]) ORDER BY account_id`,
        [[...SYSTEM_ACCOUNT_IDS]],
      ),
    ]);
    return {
      ok: !balanceMismatches.length && !orphanEntries.length && !unbalancedTransactions.length,
      checkedAt: new Date().toISOString(),
      balanceMismatches,
      orphanEntries,
      unbalancedTransactions,
      pendingEvents: { count: pending.count, oldest: pending.oldest },
      // Contrapartidas del sistema: su saldo negativo es el dinero que entró por cada vía.
      systemAccounts: systemBalances.map((row: { accountId: string; currency: string; balance: number }) => ({
        ...row,
        name: SYSTEM_ACCOUNT_NAMES[row.accountId] ?? 'Cuenta del sistema',
      })),
    };
  }

  /** Núcleo común: doble partida en una transacción SERIALIZABLE, con idempotencia y eventos en el outbox. */
  private async post(posting: Posting): Promise<LedgerTransaction> {
    const result = await this.runSerializable(async (manager) => {
      const existing = await manager.findOne(LedgerTransaction, { where: { idempotencyKey: posting.idempotencyKey } });
      if (existing) {
        if (!posting.isSameOperation(existing)) {
          throw new ConflictException('La clave de idempotencia ya se usó para otra operación.');
        }
        return { transaction: existing, created: false };
      }
      if (posting.reversedTransactionId) {
        const alreadyReversed = await manager.findOne(LedgerTransaction, {
          where: { reversedTransactionId: posting.reversedTransactionId },
        });
        if (alreadyReversed) throw new ConflictException('La transacción ya fue reversada.');
      }

      const lockedBalances = await this.lockBalances(
        manager,
        [posting.fromAccountId, posting.toAccountId],
        posting.currency,
      );
      if (posting.requireFundsIn && Number(lockedBalances.get(posting.requireFundsIn)) < Number(posting.amount)) {
        throw new BadRequestException('Saldo insuficiente.');
      }
      if (posting.limits) {
        await this.assertWithinLimits(manager, posting.fromAccountId, Number(posting.amount), posting.limits);
      }

      const row = manager.create(LedgerTransaction, {
        idempotencyKey: posting.idempotencyKey,
        userId: posting.userId,
        type: posting.type,
        sourceAccountId: posting.fromAccountId,
        destinationAccountId: posting.toAccountId,
        sourceAccountNumber: posting.sourceAccountNumber ?? null,
        destinationAccountNumber: posting.destinationAccountNumber ?? null,
        reversedTransactionId: posting.reversedTransactionId ?? null,
        amount: posting.amount,
        currency: posting.currency,
        description: posting.description,
      });
      await manager.save(row);
      await manager.save(LedgerEntry, [
        manager.create(LedgerEntry, { transactionId: row.id, accountId: posting.fromAccountId, amount: `-${posting.amount}`, currency: posting.currency }),
        manager.create(LedgerEntry, { transactionId: row.id, accountId: posting.toAccountId, amount: posting.amount, currency: posting.currency }),
      ]);
      await manager.query('UPDATE ledger_balances SET balance = balance - $1::numeric, updated_at = NOW() WHERE account_id = $2', [posting.amount, posting.fromAccountId]);
      await manager.query('UPDATE ledger_balances SET balance = balance + $1::numeric, updated_at = NOW() WHERE account_id = $2', [posting.amount, posting.toAccountId]);
      await this.outbox.enqueue(manager, EVENT_TRANSACTION_COMPLETED, posting.events(row));
      return { transaction: row, created: true };
    });

    // Publicación inmediata; si falla, el relay del outbox la reintenta.
    if (result.created) void this.outbox.flush();
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

  private eventPayload(transaction: LedgerTransaction, idUser: string, direction: 'in' | 'out') {
    return {
      idUser,
      direction,
      transactionId: transaction.id,
      type: transaction.type,
      sourceAccountId: transaction.sourceAccountId,
      sourceAccountNumber: transaction.sourceAccountNumber,
      destinationAccountId: transaction.destinationAccountId,
      destinationAccountNumber: transaction.destinationAccountNumber,
      reversedTransactionId: transaction.reversedTransactionId,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.description,
      createdAt: transaction.createdAt,
    };
  }

  private async toMovements(accountId: string, entries: LedgerEntry[]) {
    if (!entries.length) return [];
    const transactions = await this.transactions.find({
      where: { id: In([...new Set(entries.map((entry) => entry.transactionId))]) },
    });
    const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
    return entries.map((entry) => {
      const transaction = byId.get(entry.transactionId);
      const counterpartyNumber = transaction?.sourceAccountId === accountId
        ? transaction?.destinationAccountNumber
        : transaction?.sourceAccountNumber;
      return {
        id: entry.id,
        transactionId: entry.transactionId,
        type: transaction?.type ?? 'transfer',
        direction: Number(entry.amount) >= 0 ? 'in' : 'out',
        amount: Math.abs(Number(entry.amount)),
        currency: entry.currency,
        description: transaction?.description ?? 'Movimiento',
        // Solo los últimos 4 dígitos: no se expone el número ni el UUID de la cuenta de otra persona.
        counterpartyAccountLast4: counterpartyNumber ? counterpartyNumber.slice(-4) : null,
        reversedTransactionId: transaction?.reversedTransactionId ?? null,
        createdAt: entry.createdAt,
      };
    });
  }

  private async ownerOf(accountId: string): Promise<string | null> {
    if (SYSTEM_ACCOUNT_IDS.has(accountId)) return null;
    return (await this.accounts.getInternalAccount(accountId)).idUser;
  }

  /** null si se permiten las consignaciones de prueba; si no, el motivo. En producción nunca se permiten. */
  private demoDepositsBlockedReason(): string | null {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      return 'Las consignaciones de prueba están deshabilitadas en producción.';
    }
    if (this.config.get<string>('ENABLE_DEMO_DEPOSITS') !== 'true') {
      return 'Las consignaciones de prueba no están habilitadas.';
    }
    return null;
  }

  private demoDepositMax(): number {
    const configured = Number(this.config.get<string>('DEMO_DEPOSIT_MAX_AMOUNT'));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DEMO_DEPOSIT_MAX;
  }

  private systemAccount(accounts: Record<string, string>, currency: string): string {
    const id = accounts[currency];
    if (!id) throw new BadRequestException(`Moneda no soportada: ${currency}.`);
    return id;
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

  private async assertWithinLimits(manager: EntityManager, accountId: string, amount: number, limits: Limits) {
    // "Ahora" expresado en hora de Bogotá; los inicios se devuelven como instantes UTC reales.
    const bogota = new Date(Date.now() - BOGOTA_OFFSET_MS);
    const dayStart = new Date(
      Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate()) + BOGOTA_OFFSET_MS,
    );
    const monthStart = new Date(Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), 1) + BOGOTA_OFFSET_MS);
    // Los reversos no consumen cupo: devuelven dinero, no son gasto del titular.
    const spentSince = (since: Date) => manager.query(
      `SELECT COALESCE(SUM(-e.amount), 0) AS total
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = $1 AND e.amount < 0 AND e.created_at >= $2 AND t.type <> 'reversal'`,
      [accountId, since],
    );
    const [dailyRows, monthlyRows] = await Promise.all([spentSince(dayStart), spentSince(monthStart)]);
    if (Number(dailyRows[0].total) + amount > Number(limits.dailyLimit)) {
      throw new ForbiddenException('La operación supera el límite diario de la cuenta.');
    }
    if (Number(monthlyRows[0].total) + amount > Number(limits.monthlyLimit)) {
      throw new ForbiddenException('La operación supera el límite mensual de la cuenta.');
    }
  }
}
