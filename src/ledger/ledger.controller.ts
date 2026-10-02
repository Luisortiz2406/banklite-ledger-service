import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreditDto } from './dto/credit.dto';
import { DebitDto } from './dto/debit.dto';
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
  getBalance(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Req() request: Request,
  ) {
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
  deposit(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Body() dto: DepositDto,
    @Req() request: Request,
  ) {
    return this.ledger.deposit(accountId, dto, (request as any).user.idUser, (request as any).accessToken);
  }

  @Post('transfers')
  transfer(@Body() dto: TransferDto, @Req() request: Request) {
    return this.ledger.transfer(dto, (request as any).user.idUser, (request as any).accessToken);
  }
}

/** Operaciones entre servicios / del banco: requieren la clave interna, nunca un JWT de cliente. */
@Controller('ledger/internal')
@UseGuards(InternalKeyGuard)
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

  @Post('transactions/:transaction_id/reversal')
  reverse(
    @Param('transaction_id', ParseUUIDPipe) transactionId: string,
    @Body() dto: ReversalDto,
  ) {
    return this.ledger.reverse(transactionId, dto);
  }

  @Get('reconciliation')
  reconcile() {
    return this.ledger.reconcile();
  }
}
