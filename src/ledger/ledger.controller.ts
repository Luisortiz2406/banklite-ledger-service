import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreditDto } from './dto/credit.dto';
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
    return this.ledger.getBalance(accountId, (request as any).user.idUser, (request as any).accessToken);
  }

  @Get('accounts/:account_id/transactions')
  getTransactions(
    @Param('account_id', ParseUUIDPipe) accountId: string,
    @Req() request: Request,
  ) {
    return this.ledger.getTransactions(accountId, (request as any).user.idUser, (request as any).accessToken);
  }

  @Post('transfers')
  transfer(@Body() dto: TransferDto, @Req() request: Request) {
    return this.ledger.transfer(dto, (request as any).user.idUser, (request as any).accessToken);
  }
}

@Controller('ledger/internal/credits')
@UseGuards(InternalKeyGuard)
export class InternalCreditsController {
  constructor(private readonly ledger: LedgerService) {}

  @Post()
  credit(@Body() dto: CreditDto) {
    return this.ledger.credit(dto);
  }
}