import { IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_AMOUNT } from './amount';

export class TransferDto {
  @IsUUID()
  sourceAccountId: string;

  @IsString()
  @Matches(/^\d{11}$/, { message: 'destinationAccountNumber debe tener 11 dígitos' })
  destinationAccountNumber: string;

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