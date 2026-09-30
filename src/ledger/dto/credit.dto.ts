import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class CreditDto {
  @IsUUID()
  accountId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(9999999999999999)
  amount: number;

  @IsUUID()
  idempotencyKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}