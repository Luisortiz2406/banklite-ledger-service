import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_AMOUNT } from './dto/amount';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AdminAuditService } from '../common/staff/admin-audit.service';
import { StaffAuthGuard, StaffRoles } from '../common/staff/staff-auth.guard';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { LedgerService } from './ledger.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AdminTransactionsQueryDto {
  @IsOptional() @IsUUID() accountId?: string;
  @IsOptional() @IsIn(['transfer', 'credit', 'deposit', 'debit', 'reversal', 'payment']) type?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class AdminReversalDto {
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(120) reason: string;
}

export class AdminCreditDto {
  @Matches(/^\d{11}$/, { message: 'El número de cuenta debe tener 11 dígitos.' }) accountNumber: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(MAX_AMOUNT) amount: number;
  @IsString() @MinLength(5, { message: 'Escribe el motivo (mínimo 5 caracteres).' }) @MaxLength(120) reason: string;
  // La genera el panel al abrir el formulario: reenviar no abona dos veces.
  @IsUUID() idempotencyKey: string;
}

export class AdminAuditQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/** Panel administrativo de Ledger Service: movimientos, saldos, reversos y cuadre. */
@Controller('ledger/admin')
@UseGuards(StaffAuthGuard)
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly audit: AdminAuditService,
    @InjectRepository(LedgerTransaction) private readonly transactions: Repository<LedgerTransaction>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
    @InjectRepository(LedgerBalance) private readonly balances: Repository<LedgerBalance>,
  ) {}

  @Get('transactions')
  async list(@Query() q: AdminTransactionsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const qb = this.transactions.createQueryBuilder('t').orderBy('t.createdAt', 'DESC');
    if (q.accountId) qb.andWhere('(t.sourceAccountId = :acc OR t.destinationAccountId = :acc)', { acc: q.accountId });
    if (q.type) qb.andWhere('t.type = :type', { type: q.type });
    if (q.from) qb.andWhere('t.createdAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('t.createdAt < :to', { to: q.to });
    const [items, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();

    // Marca cuáles ya fueron reversadas, para que el panel no ofrezca reversarlas otra vez.
    const ids = items.map((t) => t.id);
    const reversed = ids.length
      ? await this.transactions
          .createQueryBuilder('r')
          .select('r.reversedTransactionId', 'id')
          .where('r.reversedTransactionId IN (:...ids)', { ids })
          .getRawMany<{ id: string }>()
      : [];
    const reversedIds = new Set(reversed.map((r) => r.id));
    return { items: items.map((t) => ({ ...t, amount: Number(t.amount), reversed: reversedIds.has(t.id) })), total, page, limit };
  }

  @Get('transactions/:id')
  async detail(@Param('id') id: string) {
    const tx = UUID.test(id) ? await this.transactions.findOne({ where: { id } }) : null;
    if (!tx) throw new NotFoundException('Transacción no encontrada.');
    const [entries, reversal] = await Promise.all([
      this.entries.find({ where: { transactionId: id }, order: { amount: 'ASC' } }),
      this.transactions.findOne({ where: { reversedTransactionId: id } }),
    ]);
    return {
      ...tx,
      amount: Number(tx.amount),
      entries: entries.map((e) => ({ ...e, amount: Number(e.amount) })),
      reversal: reversal ? { id: reversal.id, createdAt: reversal.createdAt, description: reversal.description } : null,
    };
  }

  @Get('accounts/:id/balance')
  async balance(@Param('id') id: string) {
    const row = UUID.test(id) ? await this.balances.findOne({ where: { accountId: id } }) : null;
    return { accountId: id, balance: row ? Number(row.balance) : 0, currency: row?.currency ?? null, updatedAt: row?.updatedAt ?? null };
  }

  @Post('transactions/:id/reversal')
  @HttpCode(200)
  @StaffRoles('admin')
  async reverse(@Param('id') id: string, @Body() dto: AdminReversalDto, @Req() req: any) {
    const reversal = await this.ledger.reverse(id, { idempotencyKey: randomUUID(), reason: dto.reason });
    await this.audit.record(req.staff, {
      action: 'transaction.reverse',
      targetType: 'transaction',
      targetId: id,
      reason: dto.reason,
      details: { reversalId: (reversal as any)?.id ?? null },
    });
    return reversal;
  }

  /**
   * Abono a una cuenta de cliente por su número (solo administradores).
   * Queda en la auditoría con el funcionario, el motivo y la transacción.
   */
  @Post('credits')
  @HttpCode(200)
  @StaffRoles('admin')
  async credit(@Body() dto: AdminCreditDto, @Req() req: any) {
    const { transaction, account } = await this.ledger.adminCredit(dto);
    // Un reenvío con la misma clave devuelve el mismo abono y no se audita dos veces.
    if (!(await this.audit.hasTransactionEntry('account.credit', transaction.id))) {
      await this.audit.record(req.staff, {
        action: 'account.credit',
        targetType: 'account',
        targetId: account.id,
        reason: dto.reason,
        details: {
          transactionId: transaction.id,
          accountNumber: account.accountNumber,
          amount: Number(transaction.amount),
          currency: transaction.currency,
        },
      });
    }
    return { ...transaction, amount: Number(transaction.amount) };
  }

  /** Volumen de las últimas 24 h por tipo (para el tablero). */
  @Get('summary')
  async summary() {
    const rows = await this.transactions
      .createQueryBuilder('t')
      .select('t.type', 'type')
      .addSelect('t.currency', 'currency')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('COALESCE(SUM(t.amount), 0)::float8', 'amount')
      .where(`t.createdAt > now() - interval '24 hours'`)
      .groupBy('t.type')
      .addGroupBy('t.currency')
      .getRawMany();
    return { since: new Date(Date.now() - 24 * 3600_000).toISOString(), byType: rows };
  }

  @Get('reconciliation')
  reconciliation() {
    return this.ledger.reconcile();
  }

  @Get('audit')
  auditLog(@Query() q: AdminAuditQueryDto) {
    return this.audit.list(q.page ?? 1, q.limit ?? 50, q.q);
  }
}
