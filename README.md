# Ledger Service (`ledger-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-ledger-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-ledger-service/actions/workflows/deploy.yml)

Libro contable de BankLite: saldos y asientos de doble partida. **Única fuente de verdad del dinero.**

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Todo movimiento de dinero del sistema termina aquí como una transacción de **doble
partida**: un asiento negativo en la cuenta origen y uno positivo en la destino, que
suman cero. El saldo de cada cuenta es la suma de sus asientos. Los demás servicios
(transfer, payment, card, rewards, savings) preparan la operación y le piden al ledger
que la registre por la red interna.

**Reglas de negocio principales**

- Transacción `SERIALIZABLE` con bloqueo de la fila del saldo (`FOR UPDATE`): no hay sobregiros por concurrencia.
- `idempotencyKey` (UUID) obligatoria: reenviar la misma clave devuelve la misma transacción y nunca duplica el movimiento.
- Valida saldo suficiente, cuenta activa, misma moneda y los límites diario/mensual de account-service.
- Tipos: `transfer`, `deposit`, `credit`, `debit`, `reversal`, `payment`, `reward`, `saving`. Una reversa crea asientos contrarios, no borra.
- Cuentas de sistema (Compensación, Consignaciones de prueba, Abonos administrativos, Recompensas, Custodia bolsillos y metas, Custodia CDT, Intereses pagados, Compensación Wompi) pueden quedar en negativo.
- Conciliación: verifica que cada saldo sea igual a la suma de sus asientos.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `transaction.completed` (uno por titular afectado) → fraud, compliance, notification, rewards. Los movimientos `saving` y los canjes a comercios no publican eventos. |
| Consume eventos | — |
| Llama a | account-service: titular, estado y límites de la cuenta |
| Lo llaman | transfer, card, payment, rewards, savings y deposit: `/ledger/internal/*` y `POST /ledger/transfers`<br>account: saldo de las cuentas que se cancelaron (`GET /ledger/internal/accounts/:id/balance`)<br>api-gateway (rutas `/ledger/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/ledger`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`ledger_db`)

| Tabla | Contenido |
|---|---|
| `ledger_transactions` | Cabecera de cada transacción (tipo, origen, destino, monto, `idempotency_key`). |
| `ledger_entries` | Asientos (débito negativo / crédito positivo) de cada transacción. |
| `ledger_balances` | Saldo actual por cuenta y moneda. |
| `ledger_outbox` | Outbox de `transaction.completed`. |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb ledger_db
psql "postgres://usuario:clave@localhost:5432/ledger_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-ledger-service .
docker run --env-file .env -p 3006:3006 banklite-ledger-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3006/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/ledger/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/ledger/accounts/:account_id/balance` | Saldo de una cuenta propia. |
| GET | `/ledger/accounts/:account_id/transactions` | Movimientos de una cuenta propia (paginados). |
| GET | `/ledger/accounts/:account_id/statement` | Extracto de un periodo. |
| GET | `/ledger/demo-deposits/config` | ¿Está activa la consignación de prueba? (no en producción). |
| POST | `/ledger/accounts/:account_id/deposits` | Consignación de prueba (solo local). |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/ledger/admin/transactions` | cualquier empleado | Busca transacciones. |
| GET | `/ledger/admin/transactions/:id` | cualquier empleado | Detalle con sus asientos. |
| GET | `/ledger/admin/accounts/:id/balance` | cualquier empleado | Saldo de cualquier cuenta. |
| POST | `/ledger/admin/transactions/:id/reversal` | admin | Reversa una transacción. |
| POST | `/ledger/admin/credits` | admin | Abono administrativo a una cuenta. |
| GET | `/ledger/admin/summary` | cualquier empleado | Volumen de las últimas 24 h por tipo. |
| GET | `/ledger/admin/reconciliation` | cualquier empleado | Conciliación saldos vs. asientos. |
| GET | `/ledger/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/ledger/transfers` | Transferencia entre cuentas (solo la usa transfer-service). |
| POST | `/ledger/internal/credits` | Abono a una cuenta. |
| POST | `/ledger/internal/debits` | Cargo a una cuenta (p. ej. compra con tarjeta). |
| POST | `/ledger/internal/payments` | Pago cliente → comercio (facturas, recargas, QR, suscripciones). |
| POST | `/ledger/internal/rewards` | Canje de puntos desde la cuenta de sistema Recompensas. |
| POST | `/ledger/internal/savings` | Bolsillos, metas y CDT: custodia e intereses. |
| POST | `/ledger/internal/cash-ins` | Recarga con Wompi contra la cuenta de sistema Compensación Wompi (tipo `deposit`). **Solo deposit-service**; idempotente por la clave que deriva del id de la transacción de Wompi. |
| POST | `/ledger/internal/transactions/:transaction_id/reversal` | Reversa de una transacción. |
| GET | `/ledger/internal/accounts/:account_id/balance` | Saldo de una cuenta. **Solo account-service**: lo vuelve a consultar después de cancelar una cuenta (alerta «cuenta cerrada con saldo»). No valida el titular. |
| GET | `/ledger/internal/reconciliation` | Conciliación saldos vs. asientos. |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `PORT` | No | `3006` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://ledger_svc:<DB_PASSWORD_LEDGER>@localhost:5432/ledger_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `INTERNAL_TRUSTED_KEYS` | **Sí** (no arranca sin ella) | `transfer:<clave-de-transfer>,card:<clave-de-card>,payment:<clave-de-payment>,rewards:<clave-de-rewards>,savings:<clave-de-savings>,deposit:<clave-de-deposit>,account:<clave-de-account>` | Claves internas que acepta, `servicio:clave,servicio:clave` (ver `InternalKeyGuard`). |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `ENABLE_DEMO_DEPOSITS` | No | `true` | Activa la consignación de prueba (se rechaza siempre en producción). |
| `DEMO_DEPOSIT_MAX_AMOUNT` | No | `5000000` | Tope de una consignación de prueba. |
| `ADMIN_CREDIT_MAX_AMOUNT` | No | `10000000` | Tope de un abono administrativo. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

Pruebas de reglas de negocio (Jest): doble partida (dos asientos que suman cero), saldo igual a la suma de asientos (conciliación), idempotencia (misma clave, misma transacción, también en paralelo), sin saldo negativo con transferencias simultáneas, límite diario y reversos.

Corren contra un PostgreSQL real, porque esas reglas dependen de transacciones,
bloqueos e índices únicos. Cada corrida crea una base temporal y la borra al terminar:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Sin `TEST_DATABASE_URL` se omiten en local; en la CI son obligatorias (el workflow
levanta un Postgres de servicio).

También se prueban los cargos, pagos a comercio, canjes, ahorro, abonos del panel,
consignaciones de prueba y reversos (saldo insuficiente, idempotencia y que un rechazo
no deje asientos ni eventos a medias), el relay del outbox, el panel administrativo con
su auditoría, los guards y la validación de la configuración.

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de
70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy
está en 86,8 % de líneas y 88,1 % de ramas.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas con Postgres (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-ledger-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `ledger-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/ledger/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** titular, estado y límites de la cuenta<br>**Lo llama:** saldo de las cuentas canceladas (`GET /ledger/internal/accounts/:id/balance`) |
| [banklite-transfer-service](https://github.com/Luisortiz2406/banklite-transfer-service) | **Lo llama:** registrar transferencias (`POST /ledger/transfers`) |
| [banklite-card-service](https://github.com/Luisortiz2406/banklite-card-service) | **Lo llama:** cargos de tarjeta y suscripciones |
| [banklite-payment-service](https://github.com/Luisortiz2406/banklite-payment-service) | **Lo llama:** pagos, recargas y pagos QR |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Lo llama:** canjes de puntos<br>**Envía:** `transaction.completed` |
| [banklite-savings-service](https://github.com/Luisortiz2406/banklite-savings-service) | **Lo llama:** movimientos de bolsillos, metas y CDT |
| [banklite-deposit-service](https://github.com/Luisortiz2406/banklite-deposit-service) | **Lo llama:** recargas con Wompi (`POST /ledger/internal/cash-ins`) |
| [banklite-fraud-service](https://github.com/Luisortiz2406/banklite-fraud-service) | **Envía:** `transaction.completed` |
| [banklite-compliance-service](https://github.com/Luisortiz2406/banklite-compliance-service) | **Envía:** `transaction.completed` |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Envía:** `transaction.completed` |
