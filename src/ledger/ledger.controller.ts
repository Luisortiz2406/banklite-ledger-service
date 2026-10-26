import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CashInDto } from './dto/cash-in.dto';
import { CreditDto } from './dto/credit.dto';
import { DebitDto } from './dto/debit.dto';
import { PaymentDto } from './dto/payment.dto';
import { RewardDto } from './dto/reward.dto';
import { SavingsDto } from './dto/savings.dto';
import { DepositDto } from './dto/deposit.dto';
import { ReversalDto } from './dto/reversal.dto';
import { StatementQueryDto, TransactionsQueryDto } from './dto/transactions-query.dto';
import { TransferDto } from './dto/transfer.dto';
import { LedgerService } from './ledger.service';

@Controller('ledger')
@UseGuards(JwtAuthGuard)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('accounts/:account_id/balance')
  getBalance(@Param('account_id', ParseUUIDPipe) accountId: string, @Req() request: Request) {
    return this.ledger.getBalance(accountId, (request as any).accessToken);
  }

  @Get('accounts/:account_id/transactions')
  getTransactions(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Query() query: TransactionsQueryDto,
    @Req() request: Request,
  ) {
    return this.ledger.getTransactions(accountId, (request as any).accessToken, query);
  }

  @Get('accounts/:account_id/statement')
  getStatement(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Query() query: StatementQueryDto,
    @Req() request: Request,
  ) {
    return this.ledger.getStatement(accountId, (request as any).accessToken, query);
  }

  @Get('demo-deposits/config')
  getDemoDepositsConfig() {
    return this.ledger.getDemoDepositsConfig();
  }

  @Post('accounts/:account_id/deposits')
  deposit(@Param('account_id', ParseUUIDPipe) accountId: string, @Body() dto: DepositDto, @Req() request: Request) {
    return this.ledger.deposit(accountId, dto, (request as any).user.idUser, (request as any).accessToken);
  }

  @Post('transfers')
  transfer(@Body() dto: TransferDto, @Req() request: Request) {
    return this.ledger.transfer(dto, (request as any).user.idUser, (request as any).accessToken);
  }
}

// Servicios que el ledger acepta solo para LEER: su clave interna no sirve para mover dinero.
const READ_ONLY_CALLERS = new Set(['account']);

/** Rechaza a los servicios de solo lectura en las rutas que mueven dinero. Va después de InternalKeyGuard. */
@Injectable()
export class MoneyCallerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const caller = context.switchToHttp().getRequest<Request & { internalCaller?: string }>().internalCaller;
    if (!caller || READ_ONLY_CALLERS.has(caller)) {
      throw new ForbiddenException('Este servicio no puede registrar movimientos en el ledger.');
    }
    return true;
  }
}

/** Operaciones entre servicios / del banco: requieren la clave interna, nunca un JWT de cliente. */
@Controller('ledger/internal')
@UseGuards(InternalKeyGuard, MoneyCallerGuard)
export class InternalLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('credits')
  credit(@Body() dto: CreditDto) {
    return this.ledger.credit(dto);
  }

  @Post('debits')
  debit(@Body() dto: DebitDto) {
    return this.ledger.debit(dto);
  }

  /** Pago cliente → comercio (cobro de suscripción). */
  @Post('payments')
  payment(@Body() dto: PaymentDto) {
    return this.ledger.payment(dto);
  }

  /** Canje de Puntos Banklite desde la cuenta "Recompensas" (rewards-service, payment-service). */
  @Post('rewards')
  reward(@Body() dto: RewardDto) {
    return this.ledger.reward(dto);
  }

  /** Bolsillos, metas y CDT (savings-service): custodia e intereses. */
  @Post('savings')
  savings(@Body() dto: SavingsDto) {
    return this.ledger.savings(dto);
  }

  /** Recarga con la pasarela Wompi: solo la puede pedir deposit-service. */
  @Post('cash-ins')
  cashIn(@Body() dto: CashInDto, @Req() request: Request) {
    if ((request as any).internalCaller !== 'deposit') {
      throw new ForbiddenException('Solo deposit-service puede registrar recargas.');
    }
    return this.ledger.cashIn(dto);
  }

  @Post('transactions/:transaction_id/reversal')
  reverse(@Param('transaction_id', ParseUUIDPipe) transactionId: string, @Body() dto: ReversalDto) {
    return this.ledger.reverse(transactionId, dto);
  }

  @Get('reconciliation')
  reconcile() {
    return this.ledger.reconcile();
  }
}

/** Consultas entre servicios que no mueven dinero. */
@Controller('ledger/internal/accounts')
@UseGuards(InternalKeyGuard)
export class InternalBalanceController {
  constructor(private readonly ledger: LedgerService) {}

  /** Saldo de una cuenta: solo account-service (revisión después de cancelar una cuenta). */
  @Get(':account_id/balance')
  balance(@Param('account_id', ParseUUIDPipe) accountId: string, @Req() request: Request) {
    if ((request as any).internalCaller !== 'account') {
      throw new ForbiddenException('Solo account-service puede consultar este saldo.');
    }
    return this.ledger.getInternalBalance(accountId);
  }
}
