import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from './ledger/ledger.module';
import { LedgerBalance } from './ledger/entities/ledger-balance.entity';
import { LedgerEntry } from './ledger/entities/ledger-entry.entity';
import { LedgerOutbox } from './ledger/entities/ledger-outbox.entity';
import { LedgerTransaction } from './ledger/entities/ledger-transaction.entity';
import { AdminAudit } from './common/staff/admin-audit.entity';
import { HealthController } from './health.controller';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
        { key: 'JWT_SECRET', type: 'secret' },
        { key: 'STAFF_JWT_SECRET', type: 'secret' },
        { key: 'INTERNAL_API_KEY', type: 'secret' },
        { key: 'INTERNAL_TRUSTED_KEYS', type: 'trusted-keys' },
        { key: 'DATABASE_URL', type: 'url' },
        { key: 'RABBITMQ_URL', type: 'url', optional: true },
      ],
        ['JWT_SECRET', 'STAFF_JWT_SECRET', 'INTERNAL_API_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [LedgerBalance, LedgerEntry, LedgerTransaction, LedgerOutbox, AdminAudit],
        synchronize: true,
        logging: false,
      }),
    }),
    LedgerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}