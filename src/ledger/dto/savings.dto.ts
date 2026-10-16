import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT } from './amount';

/**
 * Movimiento de ahorro (savings-service): la plata de bolsillos, metas y CDT
 * vive en cuentas de custodia del ledger, separada del saldo disponible.
 * - to_custody: de la cuenta del cliente a la custodia (apartar, abrir CDT).
 * - from_custody: de la custodia a la cuenta del cliente (sacar, cobrar CDT).
 * - interest_to_custody: intereses del bolsillo (cuenta "Intereses pagados" → custodia).
 * - interest_to_account: intereses de un CDT al vencer (→ cuenta del cliente).
 */
export class SavingsDto {
  @IsIn(['to_custody', 'from_custody', 'interest_to_custody', 'interest_to_account'])
  kind: 'to_custody' | 'from_custody' | 'interest_to_custody' | 'interest_to_account';

  @IsIn(['pocket', 'cdt'])
  product: 'pocket' | 'cdt';

  // Cuenta del cliente dueño del bolsillo / CDT.
  @IsUUID()
  accountId: string;

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
