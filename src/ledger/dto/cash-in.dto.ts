import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT } from './amount';

/**
 * Recarga de saldo desde una pasarela de pagos (deposit-service). La clave de
 * idempotencia la deriva quien llama del id de la transacción de la pasarela,
 * así que un aviso repetido nunca abona dos veces.
 */
export class CashInDto {
  @IsUUID()
  accountId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_AMOUNT)
  amount: number;

  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}
