import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LedgerEventPublisher');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.ConfirmChannel | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) return;
    try {
      this.connection = await amqplib.connect(url);
      this.channel = await this.connection.createConfirmChannel();
      await this.channel.assertExchange(this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events'), 'topic', { durable: true });
    } catch (error) {
      this.logger.warn(`RabbitMQ no disponible; se publicarán transacciones sin evento: ${(error as Error).message}`);
      this.channel = null;
    }
  }

  async publishTransactionCompleted(data: Record<string, unknown>) {
    if (!this.channel) return;
    const event = 'transaction.completed';
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
    try {
      this.channel.publish(exchange, event, Buffer.from(JSON.stringify({
        event,
        occurredAt: new Date().toISOString(),
        data,
      })), { persistent: true, contentType: 'application/json' });
      await this.channel.waitForConfirms();
    } catch (error) {
      this.logger.error(`No se pudo publicar ${event}: ${(error as Error).message}`);
    }
  }

  async onModuleDestroy() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}