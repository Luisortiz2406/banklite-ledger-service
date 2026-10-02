import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from './ledger/ledger.module';
import { LedgerBalance } from './ledger/entities/ledger-balance.entity';
import { LedgerEntry } from './ledger/entities/ledger-entry.entity';
import { LedgerOutbox } from './ledger/entities/ledger-outbox.entity';
import { LedgerTransaction } from './ledger/entities/ledger-transaction.entity';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [LedgerBalance, LedgerEntry, LedgerTransaction, LedgerOutbox],
        synchronize: true,
        logging: false,
      }),
    }),
    LedgerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}