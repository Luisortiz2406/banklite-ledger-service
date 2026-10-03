import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT } from './amount';

/**
 * Pago de un cliente a una cuenta de comercio (p. ej. cobro de una suscripción
 * desde card-service). Doble partida cliente → comercio, con saldo y límites.
 */
export class PaymentDto {
  @IsUUID()
  sourceAccountId: string;

  @IsUUID()
  merchantAccountId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_AMOUNT)
  amount: number;

  // Determinista por suscripción y periodo: el mismo cobro nunca se registra dos veces.
  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}
