import { IsNull } from 'typeorm';
import { createLedgerFixture } from '../testing/ledger-fixture';
import { describeWithDb, truncateAll } from '../testing/test-database';
import { LedgerOutbox } from './entities/ledger-outbox.entity';

/**
 * Outbox: el evento se guarda con los asientos y luego se publica en RabbitMQ.
 * Lo que importa: nunca se pierde un evento, uno que falla se reintenta y no
 * bloquea a los demás, y lo ya publicado no sale dos veces.
 */
describeWithDb('OutboxService (PostgreSQL)', () => {
  let fx: Awaited<ReturnType<typeof createLedgerFixture>>;
  const repo = () => fx.dataSource.getRepository(LedgerOutbox);

  beforeAll(async () => {
    fx = await createLedgerFixture();
  });
  afterAll(() => fx?.drop());
  beforeEach(async () => {
    await truncateAll(fx.dataSource);
    fx.publisher.isReady.mockReturnValue(true);
    fx.publisher.publish.mockReset().mockResolvedValue(undefined);
  });

  const enqueue = (count: number) =>
    fx.dataSource.transaction((manager) =>
      fx.outbox.enqueue(
        manager,
        'transaction.completed',
        Array.from({ length: count }, (_, i) => ({ idUser: 'u1', n: i })),
      ),
    );

  it('guardar una lista vacía no escribe nada', async () => {
    await enqueue(0);
    expect(await repo().count()).toBe(0);
  });

  it('publica lo pendiente con su clave de ruteo y marca la hora de publicación', async () => {
    await enqueue(2);
    await fx.outbox.flush();

    expect(fx.publisher.publish).toHaveBeenCalledTimes(2);
    expect(fx.publisher.publish).toHaveBeenCalledWith(
      'transaction.completed',
      expect.objectContaining({ event: 'transaction.completed', data: expect.objectContaining({ idUser: 'u1' }) }),
    );
    const rows = await repo().find();
    expect(rows.every((row) => row.publishedAt instanceof Date)).toBe(true);
  });

  it('lo ya publicado no se vuelve a publicar', async () => {
    await enqueue(1);
    await fx.outbox.flush();
    await fx.outbox.flush();
    expect(fx.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('sin conexión a RabbitMQ no publica y deja todo pendiente', async () => {
    fx.publisher.isReady.mockReturnValue(false);
    await enqueue(3);
    await fx.outbox.flush();

    expect(fx.publisher.publish).not.toHaveBeenCalled();
    expect(await repo().count({ where: { publishedAt: IsNull() } })).toBe(3);
  });

  it('si un evento falla, queda pendiente con el error y el intento, y se reintenta después', async () => {
    await enqueue(1);
    fx.publisher.publish.mockRejectedValueOnce(new Error('x'.repeat(600)));
    await fx.outbox.flush();

    const [fallido] = await repo().find();
    expect(fallido.publishedAt).toBeNull();
    expect(fallido.attempts).toBe(1);
    expect(fallido.lastError).toHaveLength(500);

    await fx.outbox.flush();
    const [reintentado] = await repo().find();
    expect(reintentado.publishedAt).toBeInstanceOf(Date);
  });

  it('un fallo no se traga los que ya salieron: los anteriores quedan publicados', async () => {
    await enqueue(3);
    fx.publisher.publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('broker caído'));
    await fx.outbox.flush();

    const rows = await repo().find({ order: { createdAt: 'ASC', id: 'ASC' } });
    expect(rows.filter((row) => row.publishedAt)).toHaveLength(1);
    expect(rows.filter((row) => !row.publishedAt)).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.attempts, 0)).toBe(1);
  });

  it('procesa más de un lote (50) en una sola pasada', async () => {
    await enqueue(120);
    await fx.outbox.flush();
    expect(fx.publisher.publish).toHaveBeenCalledTimes(120);
    expect(await repo().count()).toBe(120);
  });

  it('dos flush a la vez no publican dos veces el mismo evento', async () => {
    await enqueue(5);
    await Promise.all([fx.outbox.flush(), fx.outbox.flush()]);
    expect(fx.publisher.publish).toHaveBeenCalledTimes(5);
  });

  it('un error de la base se registra y no tumba el relay', async () => {
    await enqueue(1);
    const spy = jest.spyOn(fx.dataSource, 'transaction').mockRejectedValueOnce(new Error('base caída'));
    await expect(fx.outbox.flush()).resolves.toBeUndefined();
    spy.mockRestore();

    // El relay sigue vivo: el siguiente flush publica lo que quedó pendiente.
    await fx.outbox.flush();
    expect(fx.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('el relay se programa al iniciar el módulo y se detiene al cerrarlo', () => {
    jest.useFakeTimers();
    try {
      const flush = jest.spyOn(fx.outbox, 'flush').mockResolvedValue(undefined);
      fx.outbox.onModuleInit();
      jest.advanceTimersByTime(5_000);
      expect(flush).toHaveBeenCalledTimes(1);

      fx.outbox.onModuleDestroy();
      jest.advanceTimersByTime(20_000);
      expect(flush).toHaveBeenCalledTimes(1);
      flush.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
