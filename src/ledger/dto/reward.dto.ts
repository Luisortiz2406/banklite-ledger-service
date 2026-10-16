import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT } from './amount';

/**
 * Pago desde la cuenta de sistema "Recompensas" (canje de Puntos Banklite):
 * - target 'account': plata a la cuenta del cliente.
 * - target 'merchant': pago a un comercio en nombre del cliente (p. ej. la recarga
 *   que el banco le paga al operador). No pasa por el saldo del cliente.
 */
export class RewardDto {
  @IsIn(['account', 'merchant'])
  target: 'account' | 'merchant';

  // Cuenta del cliente (account) o del comercio (merchant).
  @IsUUID()
  accountId: string;

  // Cliente que canjeó los puntos.
  @IsUUID()
  beneficiaryUserId: string;

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
