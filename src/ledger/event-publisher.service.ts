import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';

const RECONNECT_DELAY_MS = 5000;

@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LedgerEventPublisher');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.ConfirmChannel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) return;
    try {
      const connection = await amqplib.connect(url);
      this.connection = connection;
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.scheduleReconnect();
      });
      const channel = await connection.createConfirmChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      await channel.assertExchange(this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events'), 'topic', { durable: true });
      this.channel = channel;
    } catch (error) {
      this.logger.warn(`RabbitMQ no disponible; los eventos quedan en el outbox hasta reconectar: ${(error as Error).message}`);
      // Si la conexión abrió pero falló el canal, se cierra para no dejarla colgada.
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  isReady() {
    return this.channel !== null;
  }

  /** Publica y espera la confirmación del broker. Lanza si no se pudo, para que el outbox reintente. */
  async publish(routingKey: string, message: Record<string, unknown>) {
    const channel = this.channel;
    if (!channel) throw new Error('RabbitMQ no está conectado');
    const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
    });
    await channel.waitForConfirms();
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
