import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountsClientService } from './accounts-client.service';
import { EventPublisherService } from './event-publisher.service';
import { LedgerBalance } from './entities/ledger-balance.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { InternalCreditsController, LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([LedgerBalance, LedgerEntry, LedgerTransaction]),
  ],
  controllers: [LedgerController, InternalCreditsController],
  providers: [LedgerService, AccountsClientService, EventPublisherService, JwtAuthGuard, InternalKeyGuard],
})
export class LedgerModule {}